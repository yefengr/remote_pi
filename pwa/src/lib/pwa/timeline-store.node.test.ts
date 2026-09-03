import { expect, test } from "vitest";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";
import { findTimelineConflict, isPersistableTimelineEvent, makePwaTimelineEventId, selectRecentTimelineEvents, type TimelineScope } from "./timeline-store";
import type { PwaTimelineEventRecord } from "./db";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", sessionId: "session", historyGeneration: "generation" };
type UserTimelineEvent = Extract<TimelineEvent, { kind: "user" }>;
function userEvent(eventId: string, groupId: string, timestamp: number): UserTimelineEvent { return { event_id: eventId, session_id: scope.sessionId, history_generation: scope.historyGeneration, timestamp, group_id: groupId, kind: "user", message_id: eventId, blocks: [{ type: "text", text: eventId }], origin: "extension", delivery: "normal", status: "committed" }; }
function record(event: TimelineEvent): PwaTimelineEventRecord { return { id: makePwaTimelineEventId(scope, event.event_id), deviceId: scope.deviceId, endpointId: scope.endpointId, sessionId: scope.sessionId, historyGeneration: scope.historyGeneration, eventId: event.event_id, groupId: event.group_id, timestamp: event.timestamp, event }; }

test("stores only committed grouped events", () => {
  const committed = userEvent("committed", "group-1", 1);
  const system: TimelineEvent = { event_id: "system", session_id: scope.sessionId, history_generation: scope.historyGeneration, timestamp: 2, kind: "custom", payload: { notice: true }, truncated: false };
  expect(isPersistableTimelineEvent(committed)).toBe(true);
  expect(isPersistableTimelineEvent(system)).toBe(false);
  expect(selectRecentTimelineEvents(scope, [committed, system])).toEqual([committed]);
});
test("detects divergent data for a stable device/endpoint/session/generation key", () => {
  const existing = [record(userEvent("event", "group", 1))];
  const incoming = [record({ ...userEvent("event", "group", 1), blocks: [{ type: "text", text: "different" }] })];
  expect(findTimelineConflict(existing, incoming)?.eventId).toBe("event");
});
test("omits runtime identity from the persistent key", () => {
  expect(makePwaTimelineEventId(scope, "event/1")).toBe("device:endpoint:session:generation:event%2F1");
});
