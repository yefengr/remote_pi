import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useTimelineViewport, type TimelineViewport } from "./use-timeline-viewport";

type ViewportHarnessProps = {
  onViewport: (viewport: TimelineViewport) => void;
};

function ViewportHarness({ onViewport }: ViewportHarnessProps) {
  const viewport = useTimelineViewport();

  useEffect(() => { onViewport(viewport); }, [onViewport, viewport]);

  return <div data-testid="message-list" />;
}

async function renderViewport() {
  const viewportState = { current: null as TimelineViewport | null };
  const screen = await renderPwa(<ViewportHarness onViewport={(viewport) => { viewportState.current = viewport; }} />);
  await vi.waitFor(() => expect(viewportState.current).not.toBeNull());

  const viewport = () => {
    const current = viewportState.current;
    if (!current) throw new Error("Timeline viewport did not mount.");
    return current;
  };
  const list = screen.getByTestId("message-list").element() as HTMLDivElement;
  viewport().messageListRef.current = list;
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
  const scrollTo = vi.fn();
  Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });

  return { screen, list, scrollTo, viewport };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("follows realtime output at the bottom without unread output", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().receiveRealtimeOutput("group-1");

    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" }));
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("deduplicates unread output after scrolling away without auto-scrolling", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(false));

    viewport().receiveRealtimeOutput("group-1");
    viewport().receiveRealtimeOutput("group-1");

    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));
    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

test("resumes following and clears unread output when returning to the bottom or resetting", async () => {
  const { screen, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().handleScroll(true);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);

    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-2");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().reset();
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("scrolls smoothly to Latest before resetting output following", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().showLatest();

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("cancels a pending follow animation frame on unmount", async () => {
  const requestAnimationFrame = vi.fn(() => 42);
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  const { screen, viewport } = await renderViewport();
  viewport().receiveRealtimeOutput("group-1");
  await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));

  await screen.unmount();

  expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
});
