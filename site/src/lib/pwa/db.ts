import Dexie, { type Table } from "dexie";

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
  peers!: Table<PwaPeerRecord, string>;
  pairings!: Table<PwaPeerRecord, string>;
  messages!: Table<PwaMessageRecord, string>;
  rooms!: Table<PwaRoomRecord, string>;
  settings!: Table<PwaSettingRecord, string>;

  constructor() {
    super("remote-pi-pwa");
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
        const legacyPeers = await transaction.table("peers").toArray() as Array<Omit<PwaPeerRecord, "id" | "roomId"> & { roomId?: string }>;
        await transaction.table("pairings").bulkPut(legacyPeers.map((peer) => {
          const roomId = peer.roomId || "main";
          return { ...peer, id: makePwaPeerId(peer.remoteEpk, roomId), roomId };
        }));
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
