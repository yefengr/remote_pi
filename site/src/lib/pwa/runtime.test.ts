import assert from "node:assert/strict";
import test from "node:test";
import { markStreamingMessagesInterrupted, mergeMessages, mergeRooms, migrateLegacyDefaultRelay } from "./runtime";

const LEGACY_RELAY = "https://relay-rp1.jacobmoura.work";
const CURRENT_RELAY = "https://relay-pi.yefengr.cn";

test("keeps preferred realtime messages over an older history snapshot", () => {
  const base = [{ id: "agent-1", peerEpk: "peer", roomId: "room", kind: "assistant" as const, text: "old", createdAt: 1, status: "complete" as const }];
  const realtime = [{ ...base[0], text: "new", status: "streaming" as const }];
  assert.deepEqual(mergeMessages(base, realtime), realtime);
});

test("keeps preferred room metadata over an older local cache record", () => {
  const cached = [{ id: "peer:room", peerEpk: "peer", roomId: "room", online: true, model: "old", updatedAt: 1 }];
  const snapshot = [{ ...cached[0], online: false, model: "new", updatedAt: 2 }];
  assert.deepEqual(mergeRooms(cached, snapshot), snapshot);
});

test("marks only the active room's streaming output as interrupted", () => {
  const messages = [
    { id: "active", peerEpk: "peer", roomId: "room", kind: "assistant" as const, text: "partial", createdAt: 1, status: "streaming" as const },
    { id: "other-room", peerEpk: "peer", roomId: "other", kind: "assistant" as const, text: "partial", createdAt: 2, status: "streaming" as const },
    { id: "complete", peerEpk: "peer", roomId: "room", kind: "assistant" as const, text: "done", createdAt: 3, status: "complete" as const },
  ];
  assert.deepEqual(markStreamingMessagesInterrupted(messages, "peer", "room").map((message) => message.status), ["interrupted", "streaming", "complete"]);
});

test("migrates only missing or legacy default Relay URLs", () => {
  assert.equal(migrateLegacyDefaultRelay(undefined, LEGACY_RELAY, CURRENT_RELAY), CURRENT_RELAY);
  assert.equal(migrateLegacyDefaultRelay(LEGACY_RELAY, LEGACY_RELAY, CURRENT_RELAY), CURRENT_RELAY);
  assert.equal(migrateLegacyDefaultRelay("https://custom.example.com", LEGACY_RELAY, CURRENT_RELAY), "https://custom.example.com");
});
