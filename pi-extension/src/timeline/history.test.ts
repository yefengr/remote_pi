import { describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2 } from "../protocol/v2/index.js";
import { TimelineHistoryPager } from "./history.js";
import type { TimelineEvent } from "../protocol/v2/index.js";

const MARKER = "remote-pi:timeline-v2";

type Marker = { version: 2; event_id: string; group_id?: string; kind: "user" | "custom" };

function marker(session: SessionManager, eventId: string, groupId: string, kind: Marker["kind"] = "user"): string {
  return session.appendCustomEntry(MARKER, { version: 2, event_id: eventId, group_id: groupId, kind });
}

function userEvent(session: SessionManager, eventId: string, groupId: string, text = eventId): TimelineEvent {
  return {
    event_id: eventId,
    message_id: eventId,
    session_id: session.getSessionId(),
    history_generation: session.getSessionId(),
    group_id: groupId,
    timestamp: 1,
    kind: "user",
    blocks: [{ type: "text", text }],
    origin: "unknown",
    delivery: "unknown",
    status: "committed",
  };
}

function customEvent(session: SessionManager, eventId: string, payload: unknown): TimelineEvent {
  return {
    event_id: eventId,
    session_id: session.getSessionId(),
    history_generation: session.getSessionId(),
    timestamp: 1,
    kind: "custom",
    payload: payload as never,
    truncated: false,
  };
}

function frameEvents(frames: ReturnType<TimelineHistoryPager["sync"]>): TimelineEvent[] {
  return frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.events : []);
}

function nextBefore(frames: ReturnType<TimelineHistoryPager["sync"]>): string | undefined {
  const last = frames.at(-1);
  return last?.type === "session_history_chunk" ? last.next_before : undefined;
}

function groups(count: number, session: SessionManager): { events: TimelineEvent[]; ids: string[] } {
  const events: TimelineEvent[] = [];
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const groupId = `group-${index}`;
    const eventId = `event-${index}`;
    marker(session, eventId, groupId);
    events.push(userEvent(session, eventId, groupId));
    ids.push(eventId);
  }
  return { events, ids };
}

describe("TimelineHistoryPager", () => {
  test("returns an empty authoritative chunk for a new session", () => {
    const session = SessionManager.inMemory(process.cwd());
    const pager = new TimelineHistoryPager(session, () => []);
    expect(pager.sync({ requestId: "empty", targetChannelId: "channel-1", before: null })[0]).toMatchObject({
      type: "session_history_chunk",
      final_chunk: true,
      eos: true,
      snapshot_head: session.getSessionId(),
      events: [],
      fragments: [],
    });
  });

  test("freezes the initial snapshot and paginates five atomic groups", () => {
    const session = SessionManager.inMemory(process.cwd());
    const data = groups(6, session);
    const pager = new TimelineHistoryPager(session, () => data.events);

    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", before: null });
    expect(first).toHaveLength(1);
    expect(frameEvents(first).map((event) => event.event_id)).toEqual(data.ids.slice(1));
    expect(first[0]).toMatchObject({
      type: "session_history_chunk",
      final_chunk: true,
      eos: false,
      snapshot_head: session.getLeafId(),
    });

    const cursor = nextBefore(first);
    expect(cursor).toEqual(expect.any(String));
    const second = pager.sync({ requestId: "sync-2", targetChannelId: "channel-1", before: cursor! });
    expect(frameEvents(second).map((event) => event.event_id)).toEqual([data.ids[0]]);
    expect(second[0]).toMatchObject({ type: "session_history_chunk", final_chunk: true, eos: true });
  });

  test("keeps a group atomic and does not count system events toward the group quota", () => {
    const session = SessionManager.inMemory(process.cwd());
    const data = groups(6, session);
    const systemId = "system-after-groups";
    marker(session, systemId, "", "custom");
    const system = customEvent(session, systemId, { note: "system" });
    const pager = new TimelineHistoryPager(session, () => [...data.events, system]);

    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", before: null });
    expect(frameEvents(first).map((event) => event.event_id)).toEqual([...data.ids.slice(1), systemId]);
    expect(frameEvents(first).filter((event) => event.kind === "user")).toHaveLength(5);
  });

  test("includes legacy messages in the authoritative history window", () => {
    const session = SessionManager.inMemory(process.cwd());
    const messageId = session.appendMessage({ role: "user", content: "legacy", timestamp: 1 } as never);
    const pager = new TimelineHistoryPager(session, (manager) => [{
      event_id: `legacy:${messageId}`,
      message_id: `legacy:${messageId}`,
      session_id: manager.getSessionId(),
      history_generation: manager.getSessionId(),
      group_id: `legacy:${manager.getSessionId()}`,
      timestamp: 1,
      kind: "user",
      blocks: [{ type: "text", text: "legacy" }],
      origin: "unknown",
      delivery: "unknown",
      status: "committed",
    }]);
    expect(frameEvents(pager.sync({ requestId: "legacy", targetChannelId: "channel-1", before: null }))[0]?.event_id).toBe(`legacy:${messageId}`);
  });

  test("ordinary append does not invalidate a frozen snapshot", () => {
    const session = SessionManager.inMemory(process.cwd());
    const data = groups(6, session);
    const pager = new TimelineHistoryPager(session, (manager) => {
      const events = data.events.slice();
      const branch = manager.getBranch();
      const currentIds = new Set(branch.map((entry) => entry.id));
      if (currentIds.has("new-event")) events.push(userEvent(manager, "new-event", "new-group"));
      return events;
    });

    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", before: null });
    const cursor = nextBefore(first)!;
    marker(session, "new-event", "new-group");
    const second = pager.sync({ requestId: "sync-2", targetChannelId: "channel-1", before: cursor });
    expect(frameEvents(second).map((event) => event.event_id)).toEqual([data.ids[0]]);
  });

  test("resets for branch changes, generation changes, session replacement, and unknown cursors", () => {
    const session = SessionManager.inMemory(process.cwd());
    const data = groups(6, session);
    let generation = session.getSessionId();
    const pager = new TimelineHistoryPager(session, () => data.events, () => generation);
    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", before: null });
    const cursor = nextBefore(first)!;

    expect(pager.sync({ requestId: "bad", targetChannelId: "channel-1", before: "forged" })[0]).toMatchObject({
      type: "reset", reason: "invalid_cursor",
    });

    generation = "new-generation";
    expect(pager.sync({ requestId: "generation", targetChannelId: "channel-1", before: cursor })[0]).toMatchObject({
      type: "reset", reason: "generation_changed", history_generation: "new-generation",
    });

    generation = session.getSessionId();
    const branchSession = SessionManager.inMemory(process.cwd());
    const branchData = groups(6, branchSession);
    const branchPager = new TimelineHistoryPager(branchSession, () => branchData.events);
    const branchFirst = branchPager.sync({ requestId: "branch-1", targetChannelId: "channel-1", before: null });
    const branchCursor = nextBefore(branchFirst)!;
    branchSession.resetLeaf();
    marker(branchSession, "different-root", "different-group");
    expect(branchPager.sync({ requestId: "branch-2", targetChannelId: "channel-1", before: branchCursor })[0]).toMatchObject({
      type: "reset", reason: "branch_changed",
    });
  });

  test("allows only one request per cursor and advances to eos", () => {
    const session = SessionManager.inMemory(process.cwd());
    const data = groups(6, session);
    let pager: TimelineHistoryPager;
    let cursor = "";
    let busyResult: ReturnType<TimelineHistoryPager["sync"]> | undefined;
    const recover = (manager: SessionManager): readonly TimelineEvent[] => {
      if (cursor && !busyResult) {
        busyResult = pager.sync({ requestId: "nested", targetChannelId: "channel-1", before: cursor });
      }
      return data.events;
    };
    pager = new TimelineHistoryPager(session, recover);
    const first = pager.sync({ requestId: "sync-1", targetChannelId: "channel-1", before: null });
    cursor = nextBefore(first)!;
    const second = pager.sync({ requestId: "sync-2", targetChannelId: "channel-1", before: cursor });
    expect(busyResult?.[0]).toMatchObject({ type: "protocol_error", code: "invalid_cursor" });
    expect(second.at(-1)).toMatchObject({ type: "session_history_chunk", eos: true });
    expect(pager.sync({ requestId: "again", targetChannelId: "channel-1", before: cursor })[0]).toMatchObject({
      type: "reset", reason: "invalid_cursor",
    });
  });

  test("fragments large events at 50 KiB and keeps every encoded chunk within 512 KiB", () => {
    const session = SessionManager.inMemory(process.cwd());
    const eventId = "large-event";
    marker(session, eventId, "large-group");
    const largeEvent: TimelineEvent = {
      ...userEvent(session, eventId, "large-group", "x".repeat(700 * 1024)),
    };
    const pager = new TimelineHistoryPager(session, () => [largeEvent]);
    const frames = pager.sync({ requestId: "large", targetChannelId: "channel-1", before: null });
    const fragments = frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.fragments : []);
    expect(frames.length).toBeGreaterThan(1);
    expect(fragments.length).toBeGreaterThan(10);
    expect(fragments.map((fragment) => fragment.index)).toEqual([...Array(fragments.length).keys()]);
    expect(fragments.at(-1)?.final).toBe(true);
    for (const frame of frames) {
      expect(frame.type).toBe("session_history_chunk");
      expect(JSON.stringify(frame).length).toBeGreaterThan(0);
      expect(decodeServerFrameV2(frame)).toEqual(frame);
      expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(512 * 1024);
      expect(frame.events).toHaveLength(0);
    }
    expect(frames.flatMap((frame) => frame.type === "session_history_chunk" ? frame.events : [])).toHaveLength(0);
  });

  test("returns too_large when one atomic group exceeds the 32 MiB window", () => {
    const session = SessionManager.inMemory(process.cwd());
    const events: TimelineEvent[] = [];
    for (let index = 0; index < 40; index += 1) {
      const eventId = `large-${index}`;
      marker(session, eventId, "one-large-group");
      events.push(userEvent(session, eventId, "one-large-group", "x".repeat(1024 * 1024 - 1024)));
    }
    const pager = new TimelineHistoryPager(session, () => events);
    expect(pager.sync({ requestId: "too-large", targetChannelId: "channel-1", before: null })[0]).toMatchObject({
      type: "protocol_error", code: "too_large",
    });
  });
});