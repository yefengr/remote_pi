import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
  } else {
    await page.getByRole("button", { name: "Open settings" }).click();
  }
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function expectSeededPeer(page: Page, mobile: boolean) {
  if (mobile) {
    await expect(page.getByRole("button", { name: "Open session switcher" })).toBeVisible();
    return;
  }
  await expect(page.getByRole("heading", { name: "E2E Pi" })).toBeVisible();
}

test("shows a seeded offline workspace and session controls", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspace = await pwa.seedWorkspace();

  await expectSeededPeer(page, mobile);
  if (mobile) {
    await page.getByRole("button", { name: "Open session switcher" }).click();
    const sessions = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Sessions" }) });
    await expect(sessions).toBeVisible();
    await expect(sessions.getByText(`session ID ${workspace.roomId}`, { exact: true })).toBeVisible();
    await sessions.getByRole("button", { name: "Close sessions" }).click();
    await expect(sessions).toHaveCount(0);
  } else {
    const sessionSelect = page.getByRole("combobox", { name: "Session" });
    await expect(sessionSelect).toBeVisible();
    await expect(sessionSelect).toHaveValue(workspace.roomId);
    await expect(sessionSelect).toBeDisabled();
  }

  await expect(page.getByPlaceholder("Reconnect to send a message")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pi commands" })).toBeDisabled();
});

test("cancels and confirms clear-local-data in an isolated seeded workspace", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspace = await pwa.seedWorkspace();

  await openSettings(page, mobile);
  await page.getByRole("button", { name: "Clear local data" }).click();
  const confirmation = page.getByRole("dialog", { name: "Clear this browser's Remote Pi identity, pairings, and history?" });
  await expect(confirmation).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();
  if (mobile) {
    await page.getByRole("button", { name: "Open session switcher" }).click();
    const sessions = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Sessions" }) });
    await expect(sessions.getByText("E2E Pi", { exact: true })).toBeVisible();
    await expect(sessions.getByText(`session ID ${workspace.roomId}`, { exact: true })).toBeVisible();
    await sessions.getByRole("button", { name: "Close sessions" }).click();
    await expect(sessions).toHaveCount(0);
  } else {
    await expect(page.getByRole("heading", { name: "E2E Pi" })).toBeVisible();
  }

  await openSettings(page, mobile);
  await page.getByRole("button", { name: "Clear local data" }).click();
  const navigation = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await confirmation.getByRole("button", { name: "Clear local data" }).click();
  await navigation;
  await expect(page.getByRole("heading", { name: "Your agents, within reach." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Pi" })).toHaveCount(0);
});
