import { useEffect, useRef, useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SessionSheet } from "./session-sheet";
import { renderPwa } from "@/test/browser/render";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";
import type { PairingPresence } from "./workspace-view";

const alphaPeer: PwaPeerRecord = {
  id: "peer:alpha",
  remoteEpk: "alpha-public-key-1234",
  sessionName: "Alpha",
  nickname: "Alpha Pi",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "room-current",
};

const alphaArchivePeer: PwaPeerRecord = {
  id: "peer:alpha-archive",
  remoteEpk: alphaPeer.remoteEpk,
  sessionName: "Alpha archive",
  nickname: "Alpha archive",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-02T00:00:00.000Z",
  roomId: "room-archive",
};

const betaPeer: PwaPeerRecord = {
  id: "peer:beta",
  remoteEpk: "beta-public-key-5678",
  sessionName: "Beta",
  nickname: "Beta Pi",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-03T00:00:00.000Z",
  roomId: "room-beta",
};

const gammaPeer: PwaPeerRecord = {
  id: "peer:gamma",
  remoteEpk: "gamma-public-key-9012",
  sessionName: "Gamma",
  nickname: "Gamma Pi",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-04T00:00:00.000Z",
  roomId: "room-gamma",
};

const deltaPeer: PwaPeerRecord = {
  id: "peer:delta",
  remoteEpk: "delta-public-key-3456",
  sessionName: "Delta",
  nickname: "Delta Pi",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-05T00:00:00.000Z",
  roomId: "room-delta",
};

const peers = [alphaPeer, alphaArchivePeer, betaPeer, gammaPeer, deltaPeer];

const rooms: PwaRoomRecord[] = [
  { id: "room:current", peerEpk: alphaPeer.remoteEpk, roomId: "room-current", name: "A current", cwd: "/workspace/current", online: true, updatedAt: 1 },
  { id: "room:working", peerEpk: alphaPeer.remoteEpk, roomId: "room-working", name: "B working", cwd: "/workspace/working", working: true, online: true, updatedAt: 2 },
  { id: "room:checking", peerEpk: alphaPeer.remoteEpk, roomId: "room-checking", name: "C checking", cwd: "/workspace/checking", updatedAt: 3 },
  { id: "room:offline", peerEpk: alphaPeer.remoteEpk, roomId: "room-offline", name: "D offline", cwd: "/workspace/offline", online: false, updatedAt: 4 },
  { id: "room:beta", peerEpk: betaPeer.remoteEpk, roomId: "room-beta", name: "Other pairing", cwd: "/workspace/other-peer", online: true, updatedAt: 5 },
];

const pairingPresence: Record<string, PairingPresence> = {
  [alphaPeer.id]: { status: "online", onlineSessions: 2, totalSessions: 3 },
  [alphaArchivePeer.id]: { status: "offline", onlineSessions: 50, totalSessions: 50 },
  [betaPeer.id]: { status: "partial", onlineSessions: 1, totalSessions: 2 },
  [gammaPeer.id]: { status: "offline", onlineSessions: 0, totalSessions: 1 },
};

type SessionSheetHarnessProps = {
  events: string[];
  renamed: PwaPeerRecord[];
  removed: PwaPeerRecord[];
  rejectClose?: boolean;
};

function SessionSheetHarness({ events, renamed, removed, rejectClose = false }: SessionSheetHarnessProps) {
  const [request, setRequest] = useState<{ focusOrigin: HTMLElement | null } | null>(null);
  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const actionTargetRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    actionTargetRef.current?.focus();
  }, [actionTarget]);

  const close = () => {
    events.push("close");
    if (!rejectClose) setRequest(null);
  };
  const open = () => {
    setActionTarget(null);
    setRequest({ focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };

  return (
    <>
      <button type="button" onClick={open}>Open sessions</button>
      {actionTarget ? <button ref={actionTargetRef} type="button" data-testid="session-action-target">{actionTarget}</button> : null}
      {request ? <SessionSheet
        peers={peers}
        rooms={rooms}
        activePeerId={alphaPeer.id}
        activeRoomId="room-current"
        pairingPresence={pairingPresence}
        onSelectPeer={(peerId) => { events.push(`select-peer:${peerId}`); setActionTarget(`Selected ${peerId}`); }}
        onSelectRoom={(roomId) => { events.push(`select-room:${roomId}`); setActionTarget(`Selected ${roomId}`); }}
        onPair={() => { events.push("pair"); setActionTarget("Pairing destination"); }}
        onRename={(peer) => renamed.push(peer)}
        onRemove={(peer) => removed.push(peer)}
        onClose={close}
        focusOrigin={request.focusOrigin}
      /> : null}
    </>
  );
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

function drawerRoot() {
  const root = document.querySelector<HTMLElement>(".mantine-Drawer-root");
  expect(root).not.toBeNull();
  return root!;
}

function drawerOverlay() {
  const overlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay");
  expect(overlay).not.toBeNull();
  return page.elementLocator(overlay!);
}

function roomLocator(roomId: string) {
  const room = [...document.querySelectorAll<HTMLButtonElement>(".pwa-sheet-room")]
    .find((element) => element.textContent?.includes(`session ID ${roomId}`));
  expect(room).toBeDefined();
  return page.elementLocator(room!);
}

async function openSheet(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Open sessions" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  return { trigger, dialog };
}

test("portals the accessible Drawer in the PWA root, traps focus, and restores its trigger for every close path", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={[]} removed={[]} />);
  const { trigger, dialog } = await openSheet(screen);
  const dialogElement = dialog.element();
  const root = drawerRoot();

  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  const labelledBy = dialogElement.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  await expect.element(screen.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  expect(root.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(root).getPropertyValue("--mb-z-index")).toBe("30");
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialogElement.contains(document.activeElement)).toBe(true);

  await screen.getByRole("button", { name: "Close sessions" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  const escapedDialog = screen.getByRole("dialog");
  await expect.element(escapedDialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(escapedDialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  const overlayDialog = screen.getByRole("dialog");
  await expect.element(overlayDialog).toBeVisible();
  await drawerOverlay().click();
  await expect.element(overlayDialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual(["close", "close", "close"]);
});

test("keeps focus inside the Drawer when its parent rejects a close request", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={[]} removed={[]} rejectClose />);
  const { trigger, dialog } = await openSheet(screen);
  const dialogElement = dialog.element();

  await screen.getByRole("button", { name: "Close sessions" }).click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await expect.element(trigger).not.toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("deduplicates pairing presence by first peer key and restricts sorted rooms to the active peer", async () => {
  const screen = await renderPwa(<SessionSheetHarness events={[]} renamed={[]} removed={[]} />);
  await openSheet(screen);

  await expect.element(screen.getByText("2 ONLINE", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("1 OFFLINE", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("3 of 6 sessions online", { exact: true })).toBeVisible();
  const peerRows = [...document.querySelectorAll<HTMLElement>(".pwa-sheet-peer")].map((element) => element.textContent);
  expect(peerRows).toEqual(expect.arrayContaining([
    expect.stringContaining("Alpha PiPi key alpha-pu…ONLINE2/3 SESSIONSCURRENT"),
    expect.stringContaining("Alpha archivePi key alpha-pu…OFFLINE50/50 SESSIONS"),
    expect.stringContaining("Beta PiPi key beta-pub…PARTIAL1/2 SESSIONS"),
    expect.stringContaining("Gamma PiPi key gamma-pu…OFFLINE0/1 SESSIONS"),
    expect.stringContaining("Delta PiPi key delta-pu…CHECKING0/0 SESSIONS"),
  ]));

  const activeRoomIds = [...document.querySelectorAll<HTMLElement>(".pwa-sheet-rooms .pwa-sheet-room")]
    .map((element) => element.textContent?.match(/session ID ([\w-]+)/)?.[1]?.replace("CURRENT", ""));
  expect(activeRoomIds).toEqual(["room-current", "room-working", "room-checking", "room-offline"]);
  expect([...document.querySelectorAll(".pwa-sheet-rooms .pwa-sheet-room")]
    .some((element) => element.textContent?.includes("room-beta"))).toBe(false);
});

test("keeps current, checking, and offline rooms inert while selecting an online working room before closing", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={[]} removed={[]} />);
  const { trigger } = await openSheet(screen);
  const current = roomLocator("room-current");
  const working = roomLocator("room-working");
  const checking = roomLocator("room-checking");
  const offline = roomLocator("room-offline");

  await expect.element(current).toBeDisabled();
  await expect.element(current).toHaveAttribute("title", "Current session is read-only here");
  await expect.element(checking).toBeDisabled();
  await expect.element(checking).toHaveAttribute("title", "Checking session status");
  await expect.element(offline).toBeDisabled();
  await expect.element(offline).toHaveAttribute("title", "This session is offline");
  await expect.element(working).toBeEnabled();

  (current.element() as HTMLButtonElement).click();
  (checking.element() as HTMLButtonElement).click();
  (offline.element() as HTMLButtonElement).click();
  expect(events).toEqual([]);

  await working.click();
  expect(events).toEqual(["select-room:room-working", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();
});

test("routes peer, pair, rename, and delete actions without closing for the peer-object actions", async () => {
  const events: string[] = [];
  const renamed: PwaPeerRecord[] = [];
  const removed: PwaPeerRecord[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={renamed} removed={removed} />);
  const { trigger } = await openSheet(screen);

  await screen.getByRole("button", { name: /Beta Pi Pi key/ }).click();
  expect(events).toEqual(["select-peer:peer:beta", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();

  events.length = 0;
  await trigger.click();
  await screen.getByRole("button", { name: "Pair a Pi" }).click();
  expect(events).toEqual(["pair", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();

  events.length = 0;
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await screen.getByRole("button", { name: "Rename Beta Pi" }).click();
  expect(renamed).toHaveLength(1);
  expect(renamed[0]).toBe(betaPeer);
  expect(events).toEqual([]);
  await expect.element(dialog).toBeVisible();

  await screen.getByRole("button", { name: "Delete Beta Pi" }).click();
  expect(removed).toHaveLength(1);
  expect(removed[0]).toBe(betaPeer);
  expect(events).toEqual([]);
  await expect.element(dialog).toBeVisible();
});

test("keeps the mobile Drawer in the viewport with scrollable content and reachable 44px actions", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<SessionSheetHarness events={[]} renamed={[]} removed={[]} />);
  const { dialog } = await openSheet(screen);
  const dialogElement = dialog.element();
  const body = document.querySelector<HTMLElement>(".pwa-session-sheet-body");
  expect(body).not.toBeNull();

  const rect = dialogElement.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(dialogElement.scrollWidth).toBeLessThanOrEqual(dialogElement.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(getComputedStyle(body!).overflowY).toBe("auto");

  const actions = [
    screen.getByRole("button", { name: "Close sessions" }),
    screen.getByRole("button", { name: "Pair a Pi" }),
    screen.getByRole("button", { name: "Rename Alpha Pi" }),
    screen.getByRole("button", { name: "Delete Alpha Pi" }),
  ];
  for (const action of actions) {
    await expect.element(action).toBeVisible();
    const actionRect = action.element().getBoundingClientRect();
    expect(actionRect.width).toBeGreaterThanOrEqual(44);
    expect(actionRect.height).toBeGreaterThanOrEqual(44);
    expect(actionRect.bottom).toBeGreaterThan(0);
    expect(actionRect.top).toBeLessThan(window.innerHeight);
  }
});
