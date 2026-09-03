import Dexie, { type Table } from "dexie";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";

const DATABASE_NAME = "remote-pi-pwa";
const DATABASE_OPEN_TIMEOUT_MS = 10000;

export type PwaDatabaseErrorCode = "blocked" | "versionchange" | "open_failed";

export class PwaDatabaseError extends Error {
  constructor(public readonly code: PwaDatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PwaDatabaseError";
  }
}

/** A pairing is device-scoped. Endpoint selection is intentionally separate. */
export type PwaDeviceRecord = {
  id: string;
  deviceId: string;
  relayUrl: string;
  pairedAt: string;
  nickname?: string;
  hostname?: string;
  harness?: { name: string; version: string };
};

/** One logical endpoint may receive a new runtime after a daemon restart. */
export type PwaEndpointRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  kind: "daemon" | "interactive";
  name?: string;
  cwd?: string;
  pid?: number;
  startedAt?: number;
  model?: string;
  thinking?: string;
  working?: boolean;
  /** Runtime presence is intentionally not persisted. */
  online?: boolean;
  updatedAt: number;
};

export type PwaTimelineEventRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  sessionId: string;
  historyGeneration: string;
  eventId: string;
  groupId?: string;
  timestamp: number;
  event: TimelineEvent;
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
  devices!: Table<PwaDeviceRecord, string>;
  endpoints!: Table<PwaEndpointRecord, string>;
  timelineEvents!: Table<PwaTimelineEventRecord, string>;
  settings!: Table<PwaSettingRecord, string>;

  private openFailure: PwaDatabaseError | null = null;
  private readonly openFailureListeners = new Set<(error: PwaDatabaseError) => void>();

  constructor() {
    super(DATABASE_NAME);
    this.on("blocked", () => {
      this.reportOpenFailure(new PwaDatabaseError("blocked", "Another tab is holding an older local workspace open."));
    });
    this.on("versionchange", () => {
      this.reportOpenFailure(new PwaDatabaseError("versionchange", "The local workspace changed in another tab."));
      this.close();
    });

    // Plan 69 is deliberately destructive: products were never released, so
    // no room/peer IndexedDB data is migrated or exposed to this schema.
    this.version(7).stores({
      identities: "id, publicKey",
      devices: "id, deviceId, relayUrl, pairedAt",
      endpoints: "id, deviceId, [deviceId+endpointId], endpointId, updatedAt",
      timelineEvents: "id, [deviceId+endpointId+sessionId+historyGeneration], timestamp, eventId",
      settings: "key",
    });
  }

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
}

export function makePwaDeviceId(deviceId: string): string {
  return encodeURIComponent(deviceId);
}

export function makePwaEndpointId(deviceId: string, endpointId: string): string {
  return `${encodeURIComponent(deviceId)}:${encodeURIComponent(endpointId)}`;
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
  }
}

export async function listPwaDevices(): Promise<PwaDeviceRecord[]> {
  return getPwaDatabase().devices.orderBy("pairedAt").reverse().toArray();
}

export async function listPwaEndpoints(deviceId: string): Promise<PwaEndpointRecord[]> {
  return getPwaDatabase().endpoints.where("deviceId").equals(deviceId).sortBy("updatedAt");
}

export async function removePwaDeviceData(deviceId: string, deviceRecordId: string, activeEndpointSettingKey?: string): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", [db.devices, db.endpoints, db.timelineEvents, db.settings], async () => {
    await Promise.all([
      db.devices.delete(deviceRecordId),
      db.endpoints.where("deviceId").equals(deviceId).delete(),
      db.timelineEvents.where("[deviceId+endpointId+sessionId+historyGeneration]").between(
        [deviceId, "", "", ""],
        [deviceId, "\uffff", "\uffff", "\uffff"],
        true,
        true,
      ).delete(),
      activeEndpointSettingKey ? db.settings.delete(activeEndpointSettingKey) : Promise.resolve(),
    ]);
  });
}

export async function clearPwaData(): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.timelineEvents, db.settings], async () => {
    await Promise.all([
      db.identities.clear(),
      db.devices.clear(),
      db.endpoints.clear(),
      db.timelineEvents.clear(),
      db.settings.clear(),
    ]);
  });
}
