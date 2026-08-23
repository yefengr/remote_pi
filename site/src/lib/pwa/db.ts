import Dexie, { type Table } from "dexie";

const DATABASE_NAME = "remote-pi-pwa";
const DATABASE_OPEN_TIMEOUT_MS = 10000;

export type PwaDatabaseErrorCode = "blocked" | "versionchange" | "migration_failed" | "open_failed";

export class PwaDatabaseError extends Error {
  constructor(public readonly code: PwaDatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PwaDatabaseError";
  }
}

export type PwaPeerRecord = {
  id: string;
  remoteEpk: string;
  sessionName: string;
  relayUrl: string;
  pairedAt: string;
  nickname?: string;
  roomId: string;
};

export type PwaRoomRecord = {
  id: string;
  peerEpk: string;
  roomId: string;
  name?: string;
  cwd?: string;
  startedAt?: number;
  model?: string;
  thinking?: string;
  working?: boolean;
  online: boolean;
  updatedAt: number;
};

export type PwaMessageRecord = {
  id: string;
  peerEpk: string;
  roomId: string;
  kind: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  replyTo?: string;
  status?: "streaming" | "complete" | "error";
};

export type PwaIdentityRecord = {
  id: "owner";
  publicKey: string;
  secretKey: string;
  createdAt: number;
};

type PwaSettingRecord = {
  key: string;
  value: string;
};

export class PwaDatabase extends Dexie {
  identities!: Table<PwaIdentityRecord, string>;
  private openFailure: PwaDatabaseError | null = null;
  private readonly openFailureListeners = new Set<(error: PwaDatabaseError) => void>();

  onOpenFailure(listener: (error: PwaDatabaseError) => void): () => void {
    this.openFailureListeners.add(listener);
    if (this.openFailure) listener(this.openFailure);
    return () => this.openFailureListeners.delete(listener);
  }

  getOpenFailure(): PwaDatabaseError | null {
    return this.openFailure;
  }

  private reportOpenFailure(error: PwaDatabaseError): void {
    if (this.openFailure) return;
    this.openFailure = error;
    for (const listener of this.openFailureListeners) listener(error);
  }
  peers!: Table<PwaPeerRecord, string>;
  pairings!: Table<PwaPeerRecord, string>;
  messages!: Table<PwaMessageRecord, string>;
  rooms!: Table<PwaRoomRecord, string>;
  settings!: Table<PwaSettingRecord, string>;

  constructor() {
    super(DATABASE_NAME);
    this.on("blocked", () => {
      this.reportOpenFailure(new PwaDatabaseError("blocked", "Another tab is holding an older local workspace open."));
    });
    this.on("versionchange", () => {
      this.reportOpenFailure(new PwaDatabaseError("versionchange", "The local workspace changed in another tab."));
      this.close();
    });
    this.version(1).stores({
      identities: "id, publicKey",
      peers: "remoteEpk, relayUrl, pairedAt",
      messages: "id, [peerEpk+roomId], createdAt, replyTo",
      settings: "key",
    });
    this.version(2).stores({
      identities: "id, publicKey",
      peers: "remoteEpk, relayUrl, pairedAt",
      messages: "id, [peerEpk+roomId], createdAt, replyTo",
      rooms: "id, [peerEpk+roomId], online, updatedAt",
      settings: "key",
    });
    this.version(3).stores({
      identities: "id, publicKey",
      peers: "remoteEpk, relayUrl, pairedAt",
      messages: "id, [peerEpk+roomId], createdAt, replyTo",
      rooms: "id, peerEpk, [peerEpk+roomId], online, updatedAt",
      settings: "key",
    });
    this.version(4)
      .stores({
        identities: "id, publicKey",
        peers: "remoteEpk, relayUrl, pairedAt",
        pairings: "id, remoteEpk, [remoteEpk+roomId], relayUrl, pairedAt",
        messages: "id, [peerEpk+roomId], createdAt, replyTo",
        rooms: "id, peerEpk, [peerEpk+roomId], online, updatedAt",
        settings: "key",
      })
      .upgrade(async (transaction) => {
        try {
          const legacyPeers = await transaction.table("peers").toArray() as Array<Omit<PwaPeerRecord, "id" | "roomId"> & { roomId?: string }>;
          await transaction.table("pairings").bulkPut(legacyPeers.map((peer) => {
            const roomId = peer.roomId || "main";
            return { ...peer, id: makePwaPeerId(peer.remoteEpk, roomId), roomId };
          }));
        } catch (error) {
          throw new PwaDatabaseError("migration_failed", "Could not migrate the local workspace.", { cause: error });
        }
      });
  }
}

export function makePwaPeerId(remoteEpk: string, roomId: string): string {
  return `${encodeURIComponent(remoteEpk)}:${encodeURIComponent(roomId)}`;
}

let database: PwaDatabase | null = null;

export function getPwaDatabase(): PwaDatabase {
  if (!database) database = new PwaDatabase();
  return database;
}

export async function openPwaDatabase(): Promise<PwaDatabase> {
  const db = getPwaDatabase();
  const existingFailure = db.getOpenFailure();
  if (existingFailure) throw existingFailure;
  if (db.isOpen()) return db;

  let removeFailureListener = () => {};
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const failure = new Promise<never>((_, reject) => {
    removeFailureListener = db.onOpenFailure(reject);
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new PwaDatabaseError("open_failed", "Opening the local workspace took too long.")), DATABASE_OPEN_TIMEOUT_MS);
  });
  try {
    const opening = db.open().catch((error: unknown) => {
      if (error instanceof PwaDatabaseError) throw error;
      throw new PwaDatabaseError("open_failed", "Could not open the local workspace.", { cause: error });
    });
    await Promise.race([opening, failure, timeout]);
    return db;
  } finally {
    removeFailureListener();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
}

export async function listPwaPeers(): Promise<PwaPeerRecord[]> {
  return getPwaDatabase().pairings.orderBy("pairedAt").reverse().toArray();
}

export async function listPwaRooms(peerEpk: string): Promise<PwaRoomRecord[]> {
  return getPwaDatabase().rooms.where("peerEpk").equals(peerEpk).sortBy("updatedAt");
}

export async function listPwaMessages(
  peerEpk: string,
  roomId: string,
): Promise<PwaMessageRecord[]> {
  return getPwaDatabase()
    .messages.where("[peerEpk+roomId]")
    .equals([peerEpk, roomId])
    .sortBy("createdAt");
}

export async function clearPwaData(): Promise<void> {
  await getPwaDatabase().transaction(
    "rw",
    [getPwaDatabase().identities, getPwaDatabase().peers, getPwaDatabase().pairings, getPwaDatabase().messages, getPwaDatabase().rooms, getPwaDatabase().settings],
    async () => {
      await Promise.all([
        getPwaDatabase().identities.clear(),
        getPwaDatabase().peers.clear(),
        getPwaDatabase().pairings.clear(),
        getPwaDatabase().messages.clear(),
        getPwaDatabase().rooms.clear(),
        getPwaDatabase().settings.clear(),
      ]);
    },
  );
}
