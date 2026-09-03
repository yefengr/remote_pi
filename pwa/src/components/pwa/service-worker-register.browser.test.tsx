import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ServiceWorkerNotice } from "./service-worker-register";

type NoticeHarnessProps = {
  installPrompt?: boolean;
  updateReady?: boolean;
  unsupported?: boolean;
  onInstall?: () => void;
  onUpdate?: () => void;
  onDismiss?: () => void;
};

function NoticeHarness({
  installPrompt = false,
  updateReady = false,
  unsupported = false,
  onInstall = () => {},
  onUpdate = () => {},
  onDismiss = () => {},
}: NoticeHarnessProps) {
  const [visible, setVisible] = useState(true);
  const [updateRequested, setUpdateRequested] = useState(false);
  if (!visible) return null;

  return (
    <ServiceWorkerNotice
      installPrompt={installPrompt}
      updateReady={updateReady}
      unsupported={unsupported}
      updateRequested={updateRequested}
      onInstall={onInstall}
      onUpdate={() => {
        onUpdate();
        setUpdateRequested(true);
      }}
      onDismiss={() => {
        onDismiss();
        setVisible(false);
      }}
    />
  );
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  await page.viewport(1280, 900);
});

test("renders an accessible install notice and routes install and dismiss actions", async () => {
  const onInstall = vi.fn();
  const onDismiss = vi.fn();
  const screen = await renderPwa(
    <NoticeHarness installPrompt onInstall={onInstall} onDismiss={onDismiss} />,
  );
  const notice = screen.getByRole("status");

  await expect.element(notice).toBeVisible();
  await expect.element(screen.getByText("Install Remote Pi")).toBeVisible();
  await expect.element(screen.getByText("Open this workspace from your device launcher.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Install app" }).click();
  expect(onInstall).toHaveBeenCalledTimes(1);

  await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(notice).not.toBeInTheDocument();
});

test("keeps the notice dismiss action at a 44px touch target", async () => {
  const screen = await renderPwa(<NoticeHarness unsupported />);
  const dismiss = screen.getByRole("button", { name: "Dismiss PWA notice" });
  const rect = dismiss.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("changes Refresh to a disabled Updating action after requesting an update", async () => {
  const onUpdate = vi.fn();
  const screen = await renderPwa(<NoticeHarness updateReady onUpdate={onUpdate} />);
  const refresh = screen.getByRole("button", { name: "Refresh" });

  await expect.element(screen.getByText("Remote Pi update ready")).toBeVisible();
  await refresh.click();

  expect(onUpdate).toHaveBeenCalledTimes(1);
  const updating = screen.getByRole("button", { name: "Updating" });
  await expect.element(updating).toBeDisabled();
  await expect.element(refresh).not.toBeInTheDocument();
});

test("shows only Dismiss when offline app mode is unsupported", async () => {
  const onDismiss = vi.fn();
  const screen = await renderPwa(<NoticeHarness unsupported onDismiss={onDismiss} />);

  await expect.element(screen.getByText("Offline app mode unavailable")).toBeVisible();
  await expect.element(screen.getByText(/cannot provide PWA offline startup/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});

test("keeps install and update actions independently routed when both are available", async () => {
  const onInstall = vi.fn();
  const onUpdate = vi.fn();
  const screen = await renderPwa(
    <NoticeHarness installPrompt updateReady onInstall={onInstall} onUpdate={onUpdate} />,
  );

  await screen.getByRole("button", { name: "Install app" }).click();
  expect(onInstall).toHaveBeenCalledTimes(1);
  expect(onUpdate).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Refresh" }).click();
  expect(onInstall).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Updating" })).toBeDisabled();
});

test("keeps the mobile runtime notice and all actions inside a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<NoticeHarness installPrompt updateReady />);
  const notice = screen.getByRole("status");
  const noticeRect = notice.element().getBoundingClientRect();

  expect(noticeRect.left).toBeGreaterThanOrEqual(0);
  expect(noticeRect.top).toBeGreaterThanOrEqual(0);
  expect(noticeRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(noticeRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(notice.element().scrollWidth).toBeLessThanOrEqual(notice.element().clientWidth);

  for (const name of ["Install app", "Refresh", "Dismiss PWA notice"]) {
    const action = screen.getByRole("button", { name });
    await expect.element(action).toBeVisible();
    const rect = action.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(noticeRect.left);
    expect(rect.right).toBeLessThanOrEqual(noticeRect.right);
    expect(rect.top).toBeGreaterThanOrEqual(noticeRect.top);
    expect(rect.bottom).toBeLessThanOrEqual(noticeRect.bottom);
  }
});
