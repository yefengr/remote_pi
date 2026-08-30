import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizeEd25519PublicKey } from "./crypto.js";

const PEERS_PATH = join(homedir(), ".pi", "remote", "peers.json");

export interface PeerRecord {
  name: string;
  remote_epk: string; // raw standard/base64url 32B Ed25519 Owner handle; preserved exactly
  paired_at: string;  // ISO-8601
}

export async function listPeers(): Promise<PeerRecord[]> {
  try {
    const raw = await readFile(PEERS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { peers?: unknown };
    return Array.isArray(parsed.peers) ? parsed.peers as PeerRecord[] : [];
  } catch {
    return [];
  }
}

/**
 * Strict container read used by serialized storage mutations. Valid records
 * remain verbatim so one corrupt entry never erases other pairings.
 */
async function _readPeerContainerStrict(): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(PEERS_PATH, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as { peers?: unknown };
  if (!Array.isArray(parsed.peers)) {
    throw new Error("Invalid peers.json container");
  }
  return parsed.peers;
}

let _peerMutationQueue: Promise<void> = Promise.resolve();
const _ownerSlotTokens = new Map<string, OwnerStorageToken>();
const _ownerStorageTokenBrand: unique symbol = Symbol("owner-storage-token");

/** Opaque, process-local provenance for one canonical Owner storage slot. */
export type OwnerStorageToken = {
  readonly [_ownerStorageTokenBrand]: true;
};

export interface OwnerStorageSnapshotRecord {
  readonly rawOwnerPubkey: unknown;
  readonly token: OwnerStorageToken;
}

export type ConditionalPeerRemoval =
  | { readonly outcome: "removed"; readonly nextToken: OwnerStorageToken }
  | { readonly outcome: "stale" | "not_found" | "no_authority" };

function _ownerSlotKey(rawOwnerPubkey: unknown): string {
  if (typeof rawOwnerPubkey !== "string") {
    // Invalid non-string records remain isolated; their quarantine slots never
    // collide with a valid canonical Owner identity.
    return `raw:quarantine:${typeof rawOwnerPubkey}`;
  }
  try {
    return `owner:${canonicalizeEd25519PublicKey(rawOwnerPubkey, "Owner record")}`;
  } catch {
    return `raw:string:${rawOwnerPubkey}`;
  }
}

function _tokenForSlot(slot: string): OwnerStorageToken {
  const existing = _ownerSlotTokens.get(slot);
  if (existing) return existing;
  const token = Object.freeze({ [_ownerStorageTokenBrand]: true }) as OwnerStorageToken;
  _ownerSlotTokens.set(slot, token);
  return token;
}

function _invalidateOwnerSlot(rawOwnerPubkey: unknown): OwnerStorageToken {
  const slot = _ownerSlotKey(rawOwnerPubkey);
  const token = Object.freeze({ [_ownerStorageTokenBrand]: true }) as OwnerStorageToken;
  _ownerSlotTokens.set(slot, token);
  return token;
}

function _serializePeerMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = _peerMutationQueue.then(mutation, mutation);
  _peerMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function addPeer(record: PeerRecord): Promise<void> {
  return _serializePeerMutation(async () => {
    const peers = await listPeers() as unknown[];
    const idx = peers.findIndex((peer) =>
      !!peer &&
      typeof peer === "object" &&
      (peer as { remote_epk?: unknown }).remote_epk === record.remote_epk,
    );
    if (idx >= 0) {
      peers[idx] = record; // idempotent re-pair
    } else {
      peers.push(record);
    }
    await mkdir(dirname(PEERS_PATH), { recursive: true });
    await writeFile(PEERS_PATH, JSON.stringify({ peers }, null, 2));
    // A successful re-pair is a new storage provenance event even when the
    // record bytes happen to be identical.
    _invalidateOwnerSlot(record.remote_epk);
  });
}

/**
 * Returns the set of distinct `remote_epk` values in peers.json.
 *
 * Each `remote_epk` is the paired Owner's Ed25519 public key and represents a
 * machine-scoped authorization entry.
 */
export async function listOwnerPubkeys(): Promise<unknown[]> {
  const peers = await listPeers() as unknown[];
  const seen = new Set<unknown>();
  for (const peer of peers) {
    if (!peer || typeof peer !== "object") {
      seen.add(peer);
      continue;
    }
    seen.add((peer as { remote_epk?: unknown }).remote_epk);
  }
  return [...seen];
}

/**
 * Atomically snapshots raw Owner handles and their canonical-slot provenance.
 * The token is process-local and opaque to callers.
 */
export function snapshotOwnerPubkeys(): Promise<readonly OwnerStorageSnapshotRecord[]> {
  return _serializePeerMutation(async () => {
    const peers = await _readPeerContainerStrict();
    const rawOwners = new Set<unknown>();
    for (const peer of peers) {
      if (!peer || typeof peer !== "object") {
        rawOwners.add(peer);
      } else {
        rawOwners.add((peer as { remote_epk?: unknown }).remote_epk);
      }
    }
    return [...rawOwners].map((rawOwnerPubkey) => ({
      rawOwnerPubkey,
      token: _tokenForSlot(_ownerSlotKey(rawOwnerPubkey)),
    }));
  });
}

/**
 * Removes one exact raw handle only when its snapshot provenance still owns
 * the target canonical Owner slot. The final authority/token checks and sync
 * write share the existing serialized mutation lane.
 */
export function conditionalRemovePeer(
  remoteEpk: string,
  expectedToken: OwnerStorageToken,
  canCommit?: () => boolean,
): Promise<ConditionalPeerRemoval> {
  return _serializePeerMutation(async () => {
    const slot = _ownerSlotKey(remoteEpk);
    // Provenance belongs to the canonical Owner slot, not the exact raw
    // spelling. A stale slot must therefore win over an absent old spelling.
    if (_tokenForSlot(slot) !== expectedToken) return { outcome: "stale" };
    const peers = await _readPeerContainerStrict();
    const filtered = peers.filter((peer) =>
      !peer ||
      typeof peer !== "object" ||
      (peer as { remote_epk?: unknown }).remote_epk !== remoteEpk,
    );
    if (filtered.length === peers.length) return { outcome: "not_found" };
    await mkdir(dirname(PEERS_PATH), { recursive: true });
    // No await may intervene between the final token/authority checks and
    // synchronous write, preserving the lane's fail-closed commit boundary.
    if (_tokenForSlot(slot) !== expectedToken) return { outcome: "stale" };
    if (canCommit) {
      let authorized = false;
      try { authorized = canCommit(); } catch { return { outcome: "no_authority" }; }
      if (!authorized) return { outcome: "no_authority" };
    }
    writeFileSync(PEERS_PATH, JSON.stringify({ peers: filtered }, null, 2));
    return { outcome: "removed", nextToken: _invalidateOwnerSlot(remoteEpk) };
  });
}

export function removePeer(
  remoteEpk: string,
  canCommit?: () => boolean,
): Promise<boolean> {
  return _serializePeerMutation(async () => {
    const peers = await listPeers() as unknown[];
    const filtered = peers.filter((peer) =>
      !peer ||
      typeof peer !== "object" ||
      (peer as { remote_epk?: unknown }).remote_epk !== remoteEpk,
    );
    if (filtered.length === peers.length) return false;
    await mkdir(dirname(PEERS_PATH), { recursive: true });

    const serialized = JSON.stringify({ peers: filtered }, null, 2);
    if (canCommit) {
      // Guarded commits are atomic with their final authority check: fail
      // closed on false/throw, then synchronously persist the small JSON rewrite.
      let authorized = false;
      try { authorized = canCommit(); } catch { return false; }
      if (!authorized) return false;
      writeFileSync(PEERS_PATH, serialized);
    } else {
      // Manual removals keep the established asynchronous storage behavior.
      await writeFile(PEERS_PATH, serialized);
    }
    const removed = true;
    if (removed) _invalidateOwnerSlot(remoteEpk);
    return removed;
  });
}
