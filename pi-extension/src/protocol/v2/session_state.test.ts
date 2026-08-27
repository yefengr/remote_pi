import { describe, expect, test } from "vitest";
import { V2SessionState } from "./session_state.js";

describe("V2SessionState", () => {
  test("tracks independent logical channels", () => {
    const state = new V2SessionState({ generation: "g1", clock: () => 1 });
    expect(state.hello("owner", "tab-a")).toMatchObject({ senderRef: "owner", channelId: "tab-a", ready: true });
    expect(state.hello("owner", "tab-b")).toMatchObject({ channelId: "tab-b" });
    expect(state.snapshot().channels).toHaveLength(2);
    state.removeChannel("owner", "tab-a");
    expect(state.get("owner", "tab-a")).toBeUndefined();
    expect(state.get("owner", "tab-b")).toBeDefined();
  });

  test("replays equal payload and rejects conflicting payload", () => {
    const state = new V2SessionState({ generation: "g1", clock: () => 1 });
    const request = { senderRef: "owner", clientRequestId: "r1", payload: { text: "hello", images: [], streaming_behavior: "steer" } };
    const first = state.begin(request);
    expect(first.kind).toBe("new");
    const accepted = state.update(first.record.key, "accepted", { messageId: "m1", groupId: "g" });
    expect(accepted?.status).toBe("accepted");
    expect(state.begin({ ...request, payload: { streaming_behavior: "steer", images: [], text: "hello" } })).toMatchObject({ kind: "replay", record: { status: "accepted", messageId: "m1" } });
    expect(state.begin({ ...request, payload: { ...request.payload, text: "different" } }).kind).toBe("conflict");
    expect(state.begin({
      ...request,
      payload: { ...request.payload, images: [{ data: "REVG", mime: "image/png" }] },
    }).kind).toBe("conflict");
  });

  test("generation change clears old records", () => {
    const state = new V2SessionState({ generation: "g1", clock: () => 1 });
    const first = state.begin({ senderRef: "owner", clientRequestId: "r1", payload: { text: "x" } });
    state.setGeneration("g2");
    expect(state.generation).toBe("g2");
    expect(state.getRecord(first.record.key)).toBeUndefined();
    expect(state.begin({ senderRef: "owner", clientRequestId: "r1", payload: { text: "x" } }).kind).toBe("new");
  });

  test("expires entries and evicts oldest records by capacity", () => {
    let now = 0;
    const state = new V2SessionState({ generation: "g1", maxEntries: 2, ttlMs: 10, clock: () => now });
    const one = state.begin({ senderRef: "owner", clientRequestId: "one", payload: 1 });
    state.begin({ senderRef: "owner", clientRequestId: "two", payload: 2 });
    state.begin({ senderRef: "owner", clientRequestId: "three", payload: 3 });
    expect(state.getRecord(one.record.key)).toBeUndefined();
    now = 11;
    expect(state.snapshot().records).toHaveLength(0);
  });

  test("removes all owner state", () => {
    const state = new V2SessionState({ generation: "g1", clock: () => 1 });
    state.hello("owner", "a");
    state.hello("other", "b");
    state.begin({ senderRef: "owner", clientRequestId: "r", payload: "x" });
    state.begin({ senderRef: "other", clientRequestId: "r", payload: "x" });
    state.removeOwner("owner");
    expect(state.snapshot().channels.map((channel) => channel.senderRef)).toEqual(["other"]);
    expect(state.snapshot().records.map((record) => record.senderRef)).toEqual(["other"]);
  });
});
