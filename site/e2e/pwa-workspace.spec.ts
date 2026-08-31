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

async function openEndpointSwitcher(page: Page) {
  await page.getByRole("button", { name: "Open endpoint switcher" }).click();
  const endpoints = page.getByRole("dialog").filter({ hasText: "Endpoints" });
  await expect(endpoints).toBeVisible();
  return endpoints;
}

test("shows a seeded offline workspace and session controls", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspace = await pwa.seedWorkspace();

  if (mobile) {
    const endpoints = await openEndpointSwitcher(page);
    await expect(endpoints.getByText(`endpoint ID ${workspace.endpointId}`, { exact: true })).toBeVisible();
    await endpoints.getByRole("button", { name: "Close endpoints" }).click();
    await expect(endpoints).toHaveCount(0);
  } else {
    await expect(page.getByRole("heading", { name: "E2E endpoint" })).toBeVisible();
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
    const endpoints = await openEndpointSwitcher(page);
    await expect(endpoints.getByText("E2E Pi", { exact: true })).toBeVisible();
    await expect(endpoints.getByText(`endpoint ID ${workspace.endpointId}`, { exact: true })).toBeVisible();
    await endpoints.getByRole("button", { name: "Close endpoints" }).click();
    await expect(endpoints).toHaveCount(0);
  } else {
    await expect(page.getByRole("heading", { name: "E2E endpoint" })).toBeVisible();
  }

  await openSettings(page, mobile);
  await page.getByRole("button", { name: "Clear local data" }).click();
  const navigation = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await confirmation.getByRole("button", { name: "Clear local data" }).click();
  await navigation;
  await expect(page.getByRole("heading", { name: "Your endpoints, within reach." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E endpoint" })).toHaveCount(0);
});
