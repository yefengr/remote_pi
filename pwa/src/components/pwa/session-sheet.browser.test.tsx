import { useEffect, useRef, useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SessionSheet } from "./session-sheet";
import { renderPwa } from "@/test/browser/render";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { PairingPresence } from "./workspace-view";

const alphaDevice: PwaDeviceRecord = {
  id: "device:alpha",
  deviceId: "alpha-public-key-1234",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: "Alpha Pi",
};

const betaDevice: PwaDeviceRecord = {
  id: "device:beta",
  deviceId: "beta-public-key-5678",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-03T00:00:00.000Z",
  nickname: "Beta Pi",
};

const devices = [alphaDevice, betaDevice];

const alphaEndpoints: PwaEndpointRecord[] = [
  { id: "alpha-live-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-live", runtimeInstanceId: "alpha-runtime-live", kind: "daemon", name: "A live endpoint", cwd: "/workspace/live", online: true, updatedAt: 1 },
  { id: "alpha-working-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-working", runtimeInstanceId: "alpha-runtime-working", kind: "interactive", name: "B working endpoint", cwd: "/workspace/working", working: true, online: true, updatedAt: 2 },
  { id: "alpha-checking-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-checking", runtimeInstanceId: "alpha-runtime-checking", kind: "daemon", name: "C checking endpoint", cwd: "/workspace/checking", updatedAt: 3 },
  { id: "alpha-offline-record", deviceId: alphaDevice.deviceId, endpointId: "alpha-offline", runtimeInstanceId: "alpha-runtime-offline", kind: "interactive", name: "D offline endpoint", cwd: "/workspace/offline", online: false, updatedAt: 4 },
];

const betaEndpoints: PwaEndpointRecord[] = [
  { id: "beta-live-record", deviceId: betaDevice.deviceId, endpointId: "beta-live", runtimeInstanceId: "beta-runtime-live", kind: "daemon", name: "Beta live endpoint", cwd: "/workspace/beta", online: true, updatedAt: 5 },
  { id: "beta-review-record", deviceId: betaDevice.deviceId, endpointId: "beta-review", runtimeInstanceId: "beta-runtime-review", kind: "interactive", name: "Beta review endpoint", cwd: "/workspace/review", online: false, updatedAt: 6 },
];

const endpoints = [...alphaEndpoints, ...betaEndpoints];

const pairingPresence: Record<string, PairingPresence> = {
  [alphaDevice.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 4 },
  [betaDevice.id]: { status: "partial", onlineEndpoints: 1, totalEndpoints: 2 },
};

type SessionSheetHarnessProps = {
  events: string[];
  renamed: PwaDeviceRecord[];
  removed: PwaDeviceRecord[];
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
      <button type="button" onClick={open}>Open endpoints</button>
      {actionTarget ? <button ref={actionTargetRef} type="button" data-testid="endpoint-action-target">{actionTarget}</button> : null}
      {request ? <SessionSheet
        devices={devices}
        endpoints={endpoints}
        activeDeviceId={alphaDevice.id}
        activeEndpointId="alpha-live"
        pairingPresence={pairingPresence}
        onSelectDevice={(deviceId) => { events.push(`select-device:${deviceId}`); setActionTarget(`Selected ${deviceId}`); }}
        onSelectEndpoint={(endpointId) => { events.push(`select-endpoint:${endpointId}`); setActionTarget(`Selected ${endpointId}`); }}
        onPair={() => { events.push("pair"); setActionTarget("Pairing destination"); }}
        onRename={(device) => renamed.push(device)}
        onRemove={(device) => removed.push(device)}
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

function endpointLocator(endpointId: string) {
  const endpoint = [...document.querySelectorAll<HTMLButtonElement>(".pwa-sheet-room")]
    .find((element) => element.textContent?.includes(`endpoint ID ${endpointId}`));
  expect(endpoint).toBeDefined();
  return page.elementLocator(endpoint!);
}

function deviceSelectLocator(deviceId: string) {
  const row = [...document.querySelectorAll<HTMLElement>(".pwa-sheet-peer")]
    .find((element) => element.textContent?.includes(`Device key ${deviceId.slice(0, 8)}`));
  expect(row).toBeDefined();
  const select = row!.querySelector<HTMLButtonElement>(".pwa-sheet-peer-select");
  expect(select).not.toBeNull();
  return page.elementLocator(select!);
}

async function openSheet(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Open endpoints" });
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
  await expect.element(screen.getByRole("heading", { name: "Endpoints", exact: true })).toBeVisible();
  expect(root.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(root).getPropertyValue("--mb-z-index")).toBe("30");
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialogElement.contains(document.activeElement)).toBe(true);

  await screen.getByRole("button", { name: "Close endpoints" }).click();
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

  await screen.getByRole("button", { name: "Close endpoints" }).click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await expect.element(trigger).not.toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("summarizes each device and restricts sorted endpoints to the active device", async () => {
  const screen = await renderPwa(<SessionSheetHarness events={[]} renamed={[]} removed={[]} />);
  await openSheet(screen);

  await expect.element(screen.getByText("2 ONLINE", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("0 OFFLINE", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("3 of 6 endpoints online", { exact: true })).toBeVisible();
  const deviceRows = [...document.querySelectorAll<HTMLElement>(".pwa-sheet-peer")].map((element) => element.textContent ?? "");
  expect(deviceRows).toHaveLength(2);
  expect(deviceRows.join(" ")).toContain("Alpha Pi");
  expect(deviceRows.join(" ")).toContain("Device key alpha-pu…");
  expect(deviceRows.join(" ")).toContain("Beta Pi");
  expect(deviceRows.join(" ")).toContain("Device key beta-pub…");

  const activeEndpointIds = [...document.querySelectorAll<HTMLElement>(".pwa-sheet-rooms .pwa-sheet-room")]
    .map((element) => element.querySelector("code")?.textContent?.replace("endpoint ID ", ""));
  expect(activeEndpointIds).toEqual(["alpha-live", "alpha-working", "alpha-checking", "alpha-offline"]);
  expect([...document.querySelectorAll(".pwa-sheet-rooms .pwa-sheet-room")]
    .some((element) => element.textContent?.includes("beta-live"))).toBe(false);
});

test("keeps current, checking, and offline endpoints inert while selecting an online endpoint before closing", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={[]} removed={[]} />);
  const { trigger } = await openSheet(screen);
  const current = endpointLocator("alpha-live");
  const working = endpointLocator("alpha-working");
  const checking = endpointLocator("alpha-checking");
  const offline = endpointLocator("alpha-offline");

  await expect.element(current).toBeDisabled();
  await expect.element(current).toHaveAttribute("title", "Current endpoint");
  await expect.element(checking).toBeDisabled();
  await expect.element(checking).toHaveAttribute("title", "Checking endpoint status");
  await expect.element(offline).toBeDisabled();
  await expect.element(offline).toHaveAttribute("title", "This endpoint is offline");
  await expect.element(working).toBeEnabled();

  (current.element() as HTMLButtonElement).click();
  (checking.element() as HTMLButtonElement).click();
  (offline.element() as HTMLButtonElement).click();
  expect(events).toEqual([]);

  await working.click();
  expect(events).toEqual(["select-endpoint:alpha-working", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("endpoint-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();
});

test("routes device, pair, rename, and delete actions without closing for device-object actions", async () => {
  const events: string[] = [];
  const renamed: PwaDeviceRecord[] = [];
  const removed: PwaDeviceRecord[] = [];
  const screen = await renderPwa(<SessionSheetHarness events={events} renamed={renamed} removed={removed} />);
  const { trigger } = await openSheet(screen);

  await deviceSelectLocator(betaDevice.deviceId).click();
  expect(events).toEqual(["select-device:device:beta", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("endpoint-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();

  events.length = 0;
  await trigger.click();
  await screen.getByRole("button", { name: "Pair a Pi" }).click();
  expect(events).toEqual(["pair", "close"]);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("endpoint-action-target")).toHaveFocus();
  await expect.element(trigger).not.toHaveFocus();

  events.length = 0;
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await screen.getByRole("button", { name: "Rename Beta Pi" }).click();
  expect(renamed).toHaveLength(1);
  expect(renamed[0]).toBe(betaDevice);
  expect(events).toEqual([]);
  await expect.element(dialog).toBeVisible();

  await screen.getByRole("button", { name: "Delete Beta Pi" }).click();
  expect(removed).toHaveLength(1);
  expect(removed[0]).toBe(betaDevice);
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
    screen.getByRole("button", { name: "Close endpoints" }),
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
