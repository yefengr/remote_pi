import { expect, test } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineEvent } from "@/lib/remote-pi/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderList(items: Parameters<typeof MessageList>[0]["items"], overrides: Partial<Parameters<typeof MessageList>[0]> = {}): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <MessageList
        items={items}
        hasEarlier
        listRef={createRef<HTMLDivElement>()}
        bottomSentinelRef={createRef<HTMLDivElement>()}
        onScroll={() => {}}
        {...overrides}
      />
    </PwaUiProvider>,
  );
}

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

test("uses Mantine controls for earlier records, collapse, and retry actions", () => {
  const html = renderList([{ kind: "event", event: toolEvent }, unknownPending], { onRetryUnknown: () => {} });
  const earlierButton = html.match(/<button[^>]*class="[^"]*pwa-earlier-button[^"]*"[^>]*>/)?.[0] ?? "";
  const collapseAction = html.match(/<button[^>]*aria-label="Expand message"[^>]*>/)?.[0] ?? "";
  const retryAction = html.match(/<button[^>]*aria-label="Retry delivery"[^>]*>/)?.[0] ?? "";

  expect(earlierButton).toMatch(/pwa-button/);
  expect(earlierButton).toMatch(/data-tone="secondary"/);
  expect(collapseAction).toMatch(/pwa-icon-button/);
  expect(collapseAction).toMatch(/pwa-message-toggle/);
  expect(retryAction).toMatch(/pwa-icon-button/);
  expect(retryAction).toMatch(/pwa-pending-retry/);
});

test("uses a Mantine cancel action only for cancelable queued messages", () => {
  const html = renderList([{
    ...unknownPending,
    delivery: "accepted",
    cancelable: true,
  }], { onCancelQueued: () => {} });
  const cancelAction = html.match(/<button[^>]*aria-label="Cancel queued message"[^>]*>/)?.[0] ?? "";

  expect(cancelAction).toMatch(/pwa-icon-button/);
  expect(cancelAction).toMatch(/pwa-pending-retry/);
});
