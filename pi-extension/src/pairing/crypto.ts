import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";

(ed.hashes as Record<string, unknown>)["sha512"] = (...msgs: Uint8Array[]) => {
  const h = createHash("sha512");
  for (const msg of msgs) h.update(msg);
  return Uint8Array.from(h.digest());
};

const ED25519_PUBLIC_KEY_BYTES = 32;

export interface Ed25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export class Ed25519PublicKeyError extends Error {
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "Ed25519PublicKeyError";
  }
}

export function generateEd25519Keypair(): Ed25519Keypair {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: Buffer.from(ed.getPublicKey(secretKey)) };
}

export function ed25519Sign(sk: Uint8Array, msg: Uint8Array): Uint8Array {
  return Buffer.from(ed.sign(msg, sk));
}

export function ed25519Verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  return ed.verify(sig, msg, pk);
}

/** Decodes standard or URL-safe canonical 32-byte Ed25519 public-key base64. */
export function decodeEd25519PublicKey(raw: string, field = "public key"): Uint8Array {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Ed25519PublicKeyError(field, "invalid base64 encoding");
  }
  const standard = /[+/]/.test(raw);
  const urlSafe = /[-_]/.test(raw);
  if (standard && urlSafe) throw new Ed25519PublicKeyError(field, "mixed base64 alphabets");

  const firstPadding = raw.indexOf("=");
  const body = firstPadding === -1 ? raw : raw.slice(0, firstPadding);
  const padding = firstPadding === -1 ? "" : raw.slice(firstPadding);
  const bodyPattern = urlSafe ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+$/;
  if (!bodyPattern.test(body) || (padding !== "" && !/^={1,2}$/.test(padding))) {
    throw new Ed25519PublicKeyError(field, "invalid base64 encoding");
  }
  const requiredPadding = (4 - (body.length % 4)) % 4;
  if (requiredPadding === 3 || (padding.length > 0 && padding.length !== requiredPadding)) {
    throw new Ed25519PublicKeyError(field, "invalid base64 padding");
  }
  const normalized = body.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = new Uint8Array(Buffer.from(normalized + "=".repeat(requiredPadding), "base64"));
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Ed25519PublicKeyError(field, `wrong length (${bytes.length}, expected ${ED25519_PUBLIC_KEY_BYTES})`);
  }
  const canonicalPadded = Buffer.from(bytes).toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  const normalizedInput = normalized + padding;
  if (normalizedInput !== canonicalPadded && normalizedInput !== canonicalUnpadded) {
    throw new Ed25519PublicKeyError(field, "non-canonical base64 trailing bits");
  }
  return bytes;
}

export function encodeEd25519PublicKey(bytes: Uint8Array, field = "public key"): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    const length = bytes instanceof Uint8Array ? bytes.length : 0;
    throw new Ed25519PublicKeyError(field, `wrong length (${length}, expected ${ED25519_PUBLIC_KEY_BYTES})`);
  }
  return Buffer.from(bytes).toString("base64");
}

export function canonicalizeEd25519PublicKey(raw: string, field = "public key"): string {
  return encodeEd25519PublicKey(decodeEd25519PublicKey(raw, field), field);
}

export function publicKeyFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}
