import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";
import { getPwaDatabase, type PwaTimelineEventRecord } from "./db";

/** Runtime identity deliberately does not participate in persistent history keys. */
export type TimelineScope = {
  deviceId: string;
  endpointId: string;
  sessionId: string;
  historyGeneration: string;
};

const MAX_RECENT_GROUPS = 5;

type TimelineEventWithGroup = { event: TimelineEvent; groupId: string; timestamp: number };

export class TimelineStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineStoreConflictError";
  }
}

export function makePwaTimelineEventId(scope: TimelineScope, eventId: string): string {
  return [scope.deviceId, scope.endpointId, scope.sessionId, scope.historyGeneration, eventId]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

export function isPersistableTimelineEvent(event: TimelineEvent): boolean {
  if (event.group_id === undefined) return false;
  if (event.kind === "user") return event.status === "committed";
  if (event.kind === "assistant") return event.status === "complete" || event.status === "interrupted";
  if (event.kind === "tool") return event.status === "complete" || event.status === "error" || event.status === "interrupted";
  return event.kind === "provider_error" || event.kind === "compaction" || event.kind === "branch_summary" || event.kind === "custom";
}

function eventGroupId(event: TimelineEvent): string | undefined {
  return isPersistableTimelineEvent(event) ? event.group_id : undefined;
}

function assertEventInScope(scope: TimelineScope, event: TimelineEvent): void {
  if (event.session_id !== scope.sessionId || event.history_generation !== scope.historyGeneration) {
    throw new Error("Timeline event does not belong to the active session scope.");
  }
}

function toGroupedEvents(scope: TimelineScope, events: TimelineEvent[]): TimelineEventWithGroup[] {
  const grouped: TimelineEventWithGroup[] = [];
  for (const event of events) {
    assertEventInScope(scope, event);
    const groupId = eventGroupId(event);
    if (groupId !== undefined) grouped.push({ event, groupId, timestamp: event.timestamp });
  }
  return grouped;
}

function compareEvents(a: TimelineEventWithGroup, b: TimelineEventWithGroup): number {
  return a.timestamp - b.timestamp || a.event.event_id.localeCompare(b.event.event_id);
}

function recentGroupIds(events: TimelineEventWithGroup[]): Set<string> {
  const latestByGroup = new Map<string, number>();
  for (const item of events) {
    const latest = latestByGroup.get(item.groupId);
    if (latest === undefined || item.timestamp > latest) latestByGroup.set(item.groupId, item.timestamp);
  }
  return new Set(Array.from(latestByGroup.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(-MAX_RECENT_GROUPS)
    .map(([groupId]) => groupId));
}

export function selectRecentTimelineEvents(scope: TimelineScope, events: TimelineEvent[]): TimelineEvent[] {
  const grouped = toGroupedEvents(scope, events);
  const groups = recentGroupIds(grouped);
  return grouped.filter((item) => groups.has(item.groupId)).sort(compareEvents).map((item) => item.event);
}

function toRecord(scope: TimelineScope, event: TimelineEvent): PwaTimelineEventRecord {
  const groupId = eventGroupId(event);
  if (groupId === undefined) throw new Error("Only grouped committed timeline events can be stored.");
  return {
    id: makePwaTimelineEventId(scope, event.event_id),
    deviceId: scope.deviceId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    historyGeneration: scope.historyGeneration,
    eventId: event.event_id,
    groupId,
    timestamp: event.timestamp,
    event,
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function findTimelineConflict(existing: PwaTimelineEventRecord[], incoming: PwaTimelineEventRecord[]): PwaTimelineEventRecord | undefined {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) {
    const previous = byId.get(record.id);
    if (previous !== undefined && !sameJsonValue(previous.event, record.event)) return record;
    if (previous === undefined) byId.set(record.id, record);
  }
  return undefined;
}

function scopeWhere(scope: TimelineScope): readonly [string, string, string, string] {
  return [scope.deviceId, scope.endpointId, scope.sessionId, scope.historyGeneration];
}

async function recordsForScope(scope: TimelineScope): Promise<PwaTimelineEventRecord[]> {
  return getPwaDatabase().timelineEvents.where("[deviceId+endpointId+sessionId+historyGeneration]").equals(scopeWhere(scope)).toArray();
}

async function clearScopeInTransaction(scope: TimelineScope): Promise<void> {
  await getPwaDatabase().timelineEvents.where("[deviceId+endpointId+sessionId+historyGeneration]").equals(scopeWhere(scope)).delete();
}

async function clearAndReportConflict(scope: TimelineScope, existing: PwaTimelineEventRecord[], incoming: PwaTimelineEventRecord[]): Promise<string | undefined> {
  const conflict = findTimelineConflict(existing, incoming);
  if (conflict === undefined) return undefined;
  await clearScopeInTransaction(scope);
  return conflict.eventId;
}

export async function loadRecent(scope: TimelineScope): Promise<TimelineEvent[]> {
  const records = await recordsForScope(scope);
  return selectRecentTimelineEvents(scope, records.map((record) => record.event));
}

export async function replaceRecentWindow(scope: TimelineScope, events: TimelineEvent[], realtimeJournal: TimelineEvent[] = []): Promise<void> {
  const db = getPwaDatabase();
  const incoming = toGroupedEvents(scope, [...events, ...realtimeJournal]).map((item) => toRecord(scope, item.event));
  const conflictEventId = await db.transaction("rw", db.timelineEvents, async () => {
    const existing = await recordsForScope(scope);
    const conflict = await clearAndReportConflict(scope, existing, incoming);
    if (conflict !== undefined) return conflict;
    const retained = selectRecentTimelineEvents(scope, Array.from(new Map(incoming.map((record) => [record.id, record])).values()).map((record) => record.event));
    await clearScopeInTransaction(scope);
    await db.timelineEvents.bulkPut(retained.map((event) => toRecord(scope, event)));
    return undefined;
  });
  if (conflictEventId !== undefined) throw new TimelineStoreConflictError(`Conflicting timeline event: ${conflictEventId}`);
}

export async function commitRealtime(scope: TimelineScope, events: TimelineEvent[]): Promise<void> {
  const db = getPwaDatabase();
  const incoming = toGroupedEvents(scope, events).map((item) => toRecord(scope, item.event));
  if (incoming.length === 0) return;
  const conflictEventId = await db.transaction("rw", db.timelineEvents, async () => {
    const existing = await recordsForScope(scope);
    const conflict = await clearAndReportConflict(scope, existing, incoming);
    if (conflict !== undefined) return conflict;
    const merged = new Map(existing.map((record) => [record.id, record]));
    for (const record of incoming) merged.set(record.id, record);
    const retained = selectRecentTimelineEvents(scope, Array.from(merged.values()).map((record) => record.event));
    await clearScopeInTransaction(scope);
    await db.timelineEvents.bulkPut(retained.map((event) => toRecord(scope, event)));
    return undefined;
  });
  if (conflictEventId !== undefined) throw new TimelineStoreConflictError(`Conflicting timeline event: ${conflictEventId}`);
}

export async function clearScope(scope: TimelineScope): Promise<void> {
  const db = getPwaDatabase();
  await db.transaction("rw", db.timelineEvents, () => clearScopeInTransaction(scope));
}

export const TIMELINE_STORE_MAX_GROUPS = MAX_RECENT_GROUPS;
