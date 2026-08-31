import { createRef } from "react";
import { expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { MessageList } from "./message-list";
import type { TimelineEvent } from "@/lib/remote-pi/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";

const toolEvent: Extract<TimelineEvent, { kind: "tool" }> = {
  event_id: "event-1",
  session_id: "session-1",
  history_generation: "history-1",
  timestamp: 0,
  group_id: "group-1",
  kind: "tool",
  tool_call_id: "tool-1",
  tool: "read",
  args: {},
  truncated: false,
  status: "complete",
  result: {},
};

const unknownPending: TimelinePending = {
  kind: "pending",
  id: "pending-1",
  clientRequestId: "request-1",
  requestId: "request-1",
  text: "Retry me",
  createdAt: 0,
  delivery: "unknown_delivery",
};

function renderMessageList(items: Parameters<typeof MessageList>[0]["items"]) {
  return renderPwa(
    <MessageList
      items={items}
      hasEarlier={false}
      listRef={createRef<HTMLDivElement>()}
      bottomSentinelRef={createRef<HTMLDivElement>()}
      onScroll={() => {}}
      onRetryUnknown={() => {}}
      onCancelQueued={() => {}}
    />,
  );
}

test("reports whether scrolling is within 32px of the latest output", async () => {
  const positions: boolean[] = [];
  const screen = await renderPwa(
    <MessageList
      items={[]}
      hasEarlier={false}
      listRef={createRef<HTMLDivElement>()}
      bottomSentinelRef={createRef<HTMLDivElement>()}
      onScroll={(nearBottom) => positions.push(nearBottom)}
    />,
  );
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list");
  expect(list).not.toBeNull();
  Object.defineProperties(list!, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 560 },
  });

  list!.dispatchEvent(new Event("scroll", { bubbles: true }));
  list!.scrollTop = 568;
  list!.dispatchEvent(new Event("scroll", { bubbles: true }));

  expect(positions).toEqual([false, true]);
  await screen.unmount();
});

test("message list icon controls keep 44px touch targets", async () => {
  const screen = await renderMessageList([
    { kind: "event", event: toolEvent },
    unknownPending,
    { ...unknownPending, id: "pending-2", delivery: "accepted", cancelable: true },
  ]);

  for (const name of ["Expand message", "Retry delivery", "Cancel queued message"]) {
    const control = screen.getByRole("button", { name });
    const rect = control.element().getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
  }
});
