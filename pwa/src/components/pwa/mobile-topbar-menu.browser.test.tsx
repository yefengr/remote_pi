import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { MobileTopbarMenu } from "./mobile-topbar-menu";

type MenuHarnessProps = {
  onRefresh?: () => void | Promise<void>;
  onOpenSettings?: () => void;
};

function MenuHarness({ onRefresh = () => {}, onOpenSettings = () => {} }: MenuHarnessProps) {
  return (
    <>
      <MobileTopbarMenu onRefresh={onRefresh} onOpenSettings={onOpenSettings} />
      <button type="button">Outside focus</button>
    </>
  );
}

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(async () => {
  await page.viewport(1280, 900);
});

async function settleOverlayFocus() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
}

async function openMenu(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "More options" });
  await trigger.click();
  const menu = screen.getByRole("menu");
  await expect.element(menu).toBeVisible();
  return { trigger, menu };
}

test("keeps menu actions out of the closed DOM", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "More options" });

  await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Refresh app")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Settings")).not.toBeInTheDocument();
});

test("opens an owned accessible menu and ArrowDown enters Refresh app", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "More options" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  const menu = screen.getByRole("menu");
  const refresh = screen.getByRole("menuitem", { name: "Refresh app" });

  await expect.element(menu).toBeVisible();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  const menuId = menu.element().id;
  expect(menuId).toBeTruthy();
  await expect.element(trigger).toHaveAttribute("aria-controls", menuId);
  expect(menu.element().closest(".pwa-root")).not.toBeNull();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(refresh).toHaveFocus();
});

test("closes with Escape, unmounts actions, and returns focus to More options", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { trigger, menu } = await openMenu(screen);
  const refresh = screen.getByRole("menuitem", { name: "Refresh app" });
  refresh.element().focus();
  await expect.element(refresh).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(screen.getByRole("menuitem", { name: "Refresh app" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("closes on outside click without stealing an external valid focus target", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { menu } = await openMenu(screen);
  const outside = screen.getByRole("button", { name: "Outside focus" });

  await outside.click();

  await expect.element(menu).not.toBeInTheDocument();
  await settleOverlayFocus();
  await expect.element(outside).toHaveFocus();
});

test("locks duplicate native refresh clicks until the deferred refresh settles", async () => {
  let refreshCalls = 0;
  let refreshSettled = false;
  let resolveRefresh!: () => void;
  const deferredRefresh = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const screen = await renderPwa(
    <MenuHarness
      onRefresh={() => {
        refreshCalls += 1;
        return refreshCalls === 1 ? deferredRefresh.then(() => { refreshSettled = true; }) : Promise.resolve();
      }}
    />,
  );
  const { trigger } = await openMenu(screen);
  const refresh = screen.getByRole("menuitem", { name: "Refresh app" }).element();

  refresh.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  refresh.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(refreshCalls).toBe(1);

  resolveRefresh();
  await expect.poll(() => refreshSettled).toBe(true);
  await trigger.click();
  screen.getByRole("menuitem", { name: "Refresh app" }).element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  expect(refreshCalls).toBe(2);
});

test("calls Settings exactly once and unmounts the menu actions", async () => {
  let settingsCalls = 0;
  const screen = await renderPwa(<MenuHarness onOpenSettings={() => { settingsCalls += 1; }} />);
  const { menu } = await openMenu(screen);

  await screen.getByRole("menuitem", { name: "Settings" }).click();

  expect(settingsCalls).toBe(1);
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(screen.getByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
});

test("keeps the mobile trigger, actions, and menu panel within a 390px viewport", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { menu, trigger } = await openMenu(screen);
  const refresh = screen.getByRole("menuitem", { name: "Refresh app" });
  const settings = screen.getByRole("menuitem", { name: "Settings" });
  const triggerRect = trigger.element().getBoundingClientRect();
  const menuRect = menu.element().getBoundingClientRect();

  expect(triggerRect.width).toBeGreaterThanOrEqual(44);
  expect(triggerRect.height).toBeGreaterThanOrEqual(44);
  for (const item of [refresh, settings]) {
    const rect = item.element().getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
  }
  expect(menuRect.left).toBeGreaterThanOrEqual(0);
  expect(menuRect.top).toBeGreaterThanOrEqual(0);
  expect(menuRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(menuRect.bottom).toBeLessThanOrEqual(window.innerHeight);
});
