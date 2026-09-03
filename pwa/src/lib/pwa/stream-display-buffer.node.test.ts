import { expect, test } from "vitest";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import type { TimelineEvent, TimelinePartial } from "../remote-pi/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";

function partial(id: string, group: string, delta: string, kind: "assistant" | "thinking" | "tool" = "assistant"): TimelineViewItem {
  const value: TimelinePartial = kind === "tool"
    ? { protocol_version: 2, type: "timeline_partial", session_id: "s", history_generation: "g", group_id: group, partial_id: id, kind, tool_call_id: `${id}-call`, tool: "bash", status: "delta", delta }
    : { protocol_version: 2, type: "timeline_partial", session_id: "s", history_generation: "g", group_id: group, partial_id: id, kind, status: "delta", delta };
  return { kind: "partial", partial: value, createdAt: 1 };
}

function assistantEvent(id: string, group: string, text: string): TimelineViewItem {
  const event: TimelineEvent = { event_id: id, session_id: "s", history_generation: "g", timestamp: 2, group_id: group, kind: "assistant", blocks: [{ type: "text", text }], status: "complete" };
  return { kind: "event", event };
}

function text(item: TimelineViewItem | undefined): string | undefined {
  return item?.kind === "partial" ? item.partial.delta : undefined;
}

test("shows only a small burst initially and drains within eight ticks", () => {
  const buffer = new StreamDisplayBuffer();
  const target = partial("p", "g", "abcdefghijklmnop");
  const first = buffer.ingest([target]);
  expect(text(first.items[0])).toBe("ab");
  let ticks = 0;
  while (buffer.hasPending() && ticks < 8) {
    buffer.advance();
    ticks += 1;
  }
  expect(ticks <= 8).toBe(true);
  expect(text(buffer.snapshot()[0])).toBe("abcdefghijklmnop");
});

test("does not split emoji graphemes", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("p", "g", "👨‍👩‍👧‍👦👍🏽ok")]);
  expect(text(change.items[0])).toBe("👨‍👩‍👧‍👦👍🏽");
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("👨‍👩‍👧‍👦👍🏽ok");
});

test("resegments the previous grapheme when an emoji modifier arrives", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "👍")]);
  const appended = buffer.ingest([partial("p", "g", "👍🏽ok")]);
  expect(appended.shouldRender).toBe(false);
  const advanced = buffer.advance();
  expect(text(advanced.items[0])).toBe("👍🏽o");
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("👍🏽ok");
});

test("keeps independent partial lanes separate", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("a", "ga", "alpha"), partial("b", "gb", "bravo")]);
  expect(change.items.filter((item) => item.kind === "partial").map(text)).toEqual(["al", "br"]);
});

test("hides matching formal event until the partial drains", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "long answer")]);
  const withFormal = buffer.ingest([assistantEvent("e", "g", "long answer"), partial("p", "g", "long answer")]);
  expect(withFormal.items.some((item) => item.kind === "event")).toBe(false);
  while (buffer.hasPending()) buffer.advance();
  const drained = buffer.snapshot();
  expect(drained.some((item) => item.kind === "event")).toBe(true);
  expect(drained.some((item) => item.kind === "partial")).toBe(false);
});

test("removes a partial immediately when its group has no formal event", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "answer")]);
  const cleared = buffer.ingest([]);
  expect(cleared.items.length).toBe(0);
  expect(buffer.hasPending()).toBe(false);
});

test("tool partials are shown in full immediately", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("tool", "g", "tool output", "tool")]);
  expect(text(change.items[0])).toBe("tool output");
  expect(change.hasPending).toBe(false);
});

test("same partial target does not require another render", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "abcdef")]);
  const repeated = buffer.ingest([partial("p", "g", "abcdef")]);
  expect(repeated.shouldRender).toBe(false);
});

test("keeps the full text after many small deltas", () => {
  const buffer = new StreamDisplayBuffer();
  const target = "x".repeat(1000);
  for (let length = 1; length <= target.length; length += 1) {
    buffer.ingest([partial("p", "g", target.slice(0, length))]);
  }
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe(target);
});

test("caps a new large burst after the lane has drained", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "ok")]);
  const target = `ok${"x".repeat(1000)}`;
  const appended = buffer.ingest([partial("p", "g", target)]);
  expect(appended.shouldRender).toBe(false);
  const firstTick = buffer.advance();
  const firstText = text(firstTick.items[0]);
  expect(firstText).toBeTruthy();
  expect(firstText!.length).toBeLessThan(target.length);
  expect(firstText!.length).toBeLessThanOrEqual(66);
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe(target);
});

test("reset renders the latest authoritative formal event in full", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "a long response")]);
  const change = buffer.reset([assistantEvent("e", "g", "a long response")]);
  expect(change.shouldRender).toBe(true);
  expect(change.items.some((item) => item.kind === "partial")).toBe(false);
  expect(change.items.some((item) => item.kind === "event")).toBe(true);
  expect(buffer.hasPending()).toBe(false);
});
