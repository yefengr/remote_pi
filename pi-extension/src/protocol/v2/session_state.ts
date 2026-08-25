import { createHash } from "node:crypto";

export type V2IdempotencyStatus = "received" | "accepted" | "committed" | "unknown_delivery";

export type V2ChannelState = {
  readonly senderRef: string;
  readonly channelId: string;
  readonly ready: true;
  readonly lastSeen: number;
};

export type V2IdempotencyRequest = {
  senderRef: string;
  clientRequestId: string;
  payload: unknown;
};

export type V2IdempotencyRecord = {
  readonly key: string;
  readonly generation: string;
  readonly senderRef: string;
  readonly clientRequestId: string;
  readonly fingerprint: string;
  status: V2IdempotencyStatus;
  messageId?: string;
  groupId?: string;
  touchedAt: number;
};

type Clock = () => number;

export type V2SessionStateOptions = {
  generation: string;
  maxEntries?: number;
  ttlMs?: number;
  clock?: Clock;
};

type BeginResult =
  | { kind: "new"; record: V2IdempotencyRecord }
  | { kind: "replay"; record: V2IdempotencyRecord }
  | { kind: "conflict"; record: V2IdempotencyRecord };

export class V2SessionState {
  private generationValue: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly channels = new Map<string, V2ChannelState>();
  private readonly records = new Map<string, V2IdempotencyRecord>();

  constructor(options: V2SessionStateOptions) {
    if (!options.generation) throw new Error("generation is required");
    this.generationValue = options.generation;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 512));
    this.ttlMs = Math.max(1, options.ttlMs ?? 10 * 60 * 1000);
    this.clock = options.clock ?? Date.now;
  }

  get generation(): string {
    return this.generationValue;
  }

  setGeneration(generation: string): void {
    if (!generation) throw new Error("generation is required");
    if (generation === this.generationValue) return;
    this.generationValue = generation;
    this.records.clear();
  }

  hello(senderRef: string, channelId: string): V2ChannelState {
    this.assertId(senderRef, "senderRef");
    this.assertId(channelId, "channelId");
    const state: V2ChannelState = {
      senderRef,
      channelId,
      ready: true,
      lastSeen: this.clock(),
    };
    this.channels.set(this.channelKey(senderRef, channelId), state);
    return state;
  }

  touch(senderRef: string, channelId: string): V2ChannelState | undefined {
    const current = this.get(senderRef, channelId);
    if (!current) return undefined;
    const state: V2ChannelState = { ...current, lastSeen: this.clock() };
    this.channels.set(this.channelKey(senderRef, channelId), state);
    return state;
  }

  get(senderRef: string, channelId: string): V2ChannelState | undefined {
    return this.channels.get(this.channelKey(senderRef, channelId));
  }

  removeChannel(senderRef: string, channelId: string): void {
    this.channels.delete(this.channelKey(senderRef, channelId));
  }

  removeOwner(senderRef: string): void {
    for (const [key, channel] of this.channels) {
      if (channel.senderRef === senderRef) this.channels.delete(key);
    }
    for (const [key, record] of this.records) {
      if (record.senderRef === senderRef) this.records.delete(key);
    }
  }

  begin(request: V2IdempotencyRequest): BeginResult {
    this.prune();
    this.assertId(request.senderRef, "senderRef");
    this.assertId(request.clientRequestId, "clientRequestId");
    const key = this.recordKey(request.senderRef, request.clientRequestId);
    const fingerprint = fingerprintPayload(request.payload);
    const existing = this.records.get(key);
    if (existing) {
      existing.touchedAt = this.clock();
      this.records.delete(key);
      this.records.set(key, existing);
      return {
        kind: existing.fingerprint === fingerprint ? "replay" : "conflict",
        record: { ...existing },
      };
    }
    const record: V2IdempotencyRecord = {
      key,
      generation: this.generationValue,
      senderRef: request.senderRef,
      clientRequestId: request.clientRequestId,
      fingerprint,
      status: "received",
      touchedAt: this.clock(),
    };
    this.records.set(key, record);
    this.pruneCapacity();
    return { kind: "new", record: { ...record } };
  }

  update(
    key: string,
    status: V2IdempotencyStatus,
    details: { messageId?: string; groupId?: string } = {},
  ): V2IdempotencyRecord | undefined {
    this.prune();
    const record = this.records.get(key);
    if (!record) return undefined;
    record.status = status;
    if (details.messageId !== undefined) record.messageId = details.messageId;
    if (details.groupId !== undefined) record.groupId = details.groupId;
    record.touchedAt = this.clock();
    this.records.delete(key);
    this.records.set(key, record);
    return { ...record };
  }

  rememberUnknownDelivery(key: string): V2IdempotencyRecord | undefined {
    return this.update(key, "unknown_delivery");
  }

  getRecord(key: string): V2IdempotencyRecord | undefined {
    this.prune();
    const record = this.records.get(key);
    return record ? { ...record } : undefined;
  }

  forget(key: string): boolean {
    return this.records.delete(key);
  }

  snapshot(): { channels: V2ChannelState[]; records: V2IdempotencyRecord[] } {
    this.prune();
    return {
      channels: [...this.channels.values()].map((channel) => ({ ...channel })),
      records: [...this.records.values()].map((record) => ({ ...record })),
    };
  }

  private prune(): void {
    const now = this.clock();
    for (const [key, record] of this.records) {
      if (now - record.touchedAt >= this.ttlMs) this.records.delete(key);
    }
    this.pruneCapacity();
  }

  private pruneCapacity(): void {
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  private recordKey(senderRef: string, clientRequestId: string): string {
    return `${this.generationValue}\u0000${senderRef}\u0000${clientRequestId}`;
  }

  private channelKey(senderRef: string, channelId: string): string {
    return `${senderRef}\u0000${channelId}`;
  }

  private assertId(value: string, name: string): void {
    if (!value || value.length > 256) throw new Error(`${name} is invalid`);
  }
}

function fingerprintPayload(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return String(value);
}

export function fingerprintV2Payload(value: unknown): string {
  return fingerprintPayload(value);
}
