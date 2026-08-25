import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";
import {
  findTimelineConflict,
  isPersistableTimelineEvent,
  makePwaTimelineEventId,
  selectRecentTimelineEvents,
  type TimelineScope,
} from "./timeline-store";
import type { PwaTimelineEventRecord } from "./db";

const scope: TimelineScope = {
  peerEpk: "peer",
  roomId: "room",
  sessionId: "session",
  historyGeneration: "generation",
};

type UserTimelineEvent = Extract<TimelineEvent, { kind: "user" }>;

type AssistantTimelineEvent = Extract<TimelineEvent, { kind: "assistant" }>;

function userEvent(eventId: string, groupId: string, timestamp: number): UserTimelineEvent {
  return {
    event_id: eventId,
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    timestamp,
    group_id: groupId,
    kind: "user",
    message_id: eventId,
    blocks: [{ type: "text", text: eventId }],
    origin: "extension",
    delivery: "normal",
    status: "committed",
  };
}

function streamingAssistantEvent(eventId: string, groupId: string, timestamp: number): AssistantTimelineEvent {
  return {
    event_id: eventId,
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    timestamp,
    group_id: groupId,
    kind: "assistant",
    blocks: [{ type: "text", text: eventId }],
    status: "complete",
  };
}

function record(event: TimelineEvent): PwaTimelineEventRecord {
  return {
    id: makePwaTimelineEventId(scope, event.event_id),
    peerEpk: scope.peerEpk,
    roomId: scope.roomId,
    sessionId: scope.sessionId,
    historyGeneration: scope.historyGeneration,
    eventId: event.event_id,
    groupId: event.group_id,
    timestamp: event.timestamp,
    event,
  };
}

test("stores only committed grouped events and excludes system events without a group", () => {
  const committed = userEvent("committed", "group-1", 1);
  const ungroupedSystem: TimelineEvent = {
    event_id: "system",
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    timestamp: 2,
    kind: "custom",
    payload: { notice: true },
    truncated: false,
  };
  const completeAssistant = streamingAssistantEvent("assistant", "group-1", 3);
  assert.equal(isPersistableTimelineEvent(committed), true);
  assert.equal(isPersistableTimelineEvent(ungroupedSystem), false);
  assert.deepEqual(selectRecentTimelineEvents(scope, [committed, ungroupedSystem, completeAssistant]), [committed, completeAssistant]);
});

test("retains complete groups together and evicts the sixth oldest group", () => {
  const events = Array.from({ length: 6 }, (_, index) => userEvent(`event-${index}`, `group-${index}`, index));
  const selected = selectRecentTimelineEvents(scope, [events[0], events[1], ...events.slice(2).reverse()]);
  assert.deepEqual(selected.map((event) => event.group_id), ["group-1", "group-2", "group-3", "group-4", "group-5"]);
});

test("detects same-key divergent content without allowing overwrite", () => {
  const existing = [record(userEvent("event-1", "group-1", 1))];
  const incoming = [record({ ...userEvent("event-1", "group-1", 1), blocks: [{ type: "text", text: "different" }] })];
  assert.equal(findTimelineConflict(existing, incoming)?.eventId, "event-1");
  assert.equal(findTimelineConflict(existing, [existing[0]]), undefined);
});

test("scope and event id form a stable storage key", () => {
  assert.equal(
    makePwaTimelineEventId(scope, "event/1"),
    "peer:room:session:generation:event%2F1",
  );
});
