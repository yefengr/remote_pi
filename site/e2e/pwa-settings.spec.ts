import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

const TEST_RELAY_URL = "http://127.0.0.1:9";

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
  } else {
    await page.getByRole("button", { name: "Open settings" }).click();
  }
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

test("opens, persists a local relay URL, and closes settings", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await pwa.open();

  await openSettings(page, mobile);
  const relayInput = page.getByRole("textbox", { name: "Relay URL" });
  await relayInput.fill(TEST_RELAY_URL);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your endpoints, within reach." })).toBeVisible();
  await openSettings(page, mobile);
  await expect(page.getByRole("textbox", { name: "Relay URL" })).toHaveValue(TEST_RELAY_URL);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
});
