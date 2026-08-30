import { test, expect } from "./fixtures/pwa";

test("redirects the root route to the PWA", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Your agents, within reach." })).toBeVisible();
});

test("opens an empty PWA without horizontal overflow and activates the app service worker", async ({ context, page, pwa }) => {
  const serviceWorker = context.waitForEvent("serviceworker");

  await pwa.open();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

  const worker = await serviceWorker;
  expect(new URL(worker.url()).pathname).toBe("/sw.js");
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/app");
    const readyRegistration = await navigator.serviceWorker.ready;
    return {
      activeState: registration?.active?.state,
      readyScope: readyRegistration.scope,
      scope: registration?.scope,
    };
  })).toEqual({
    activeState: "activated",
    readyScope: `${new URL(page.url()).origin}/app`,
    scope: `${new URL(page.url()).origin}/app`,
  });
});
