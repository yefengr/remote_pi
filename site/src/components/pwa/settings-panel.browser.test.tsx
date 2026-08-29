import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SettingsPanel } from "./settings-panel";

const relayUrl = "https://relay.example.test";
const defaultRelayUrl = "https://relay.default.test";

type SettingsHarnessProps = {
  events: string[];
  onSave?: (value: string) => Promise<void>;
  closeAfterSave?: boolean;
  rejectClose?: boolean;
  mobileOrigin?: boolean;
};

type SettingsRequest = {
  focusOrigin: HTMLElement | null;
};

function SettingsHarness({ events, onSave = async () => {}, closeAfterSave = false, rejectClose = false, mobileOrigin = false }: SettingsHarnessProps) {
  const [request, setRequest] = useState<SettingsRequest | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const open = () => {
    setRequest({ focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };
  const save = async (value: string) => {
    await onSave(value);
    if (closeAfterSave) setRequest(null);
  };
  const close = () => {
    events.push("close");
    if (!rejectClose) setRequest(null);
  };
  const clear = async () => {
    events.push("clear");
  };
  const reset = () => {
    events.push("reset");
    setRequest(null);
  };

  return (
    <>
      {!mobileOrigin ? <button type="button" onClick={open}>Open settings</button> : <>
        <button type="button" aria-label="More options" onClick={() => setMobileMenuOpen(true)}>More options</button>
        <div style={{ display: mobileMenuOpen ? "block" : "none" }}>
          <button type="button" onClick={() => { setMobileMenuOpen(false); open(); }}>Mobile settings</button>
        </div>
      </>}
      {request ? <SettingsPanel
        relayUrl={relayUrl}
        defaultRelayUrl={defaultRelayUrl}
        onSave={save}
        onClose={close}
        onClearData={clear}
        onResetLayout={reset}
        focusOrigin={request.focusOrigin}
        focusFallbackSelectors={mobileOrigin ? ['button[aria-label="More options"]'] : []}
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

async function openSettings(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Open settings" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  return { trigger, dialog };
}

test("portals an accessible Settings Drawer in the PWA root and traps focus", async () => {
  const screen = await renderPwa(<SettingsHarness events={[]} />);
  const { dialog } = await openSettings(screen);
  const dialogElement = dialog.element();
  const root = drawerRoot();
  const labelledBy = dialogElement.getAttribute("aria-labelledby");

  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  expect(labelledBy).toBeTruthy();
  expect(document.getElementById(labelledBy!)?.textContent).toContain("Settings");
  await expect.element(screen.getByText("Settings", { exact: true })).toBeVisible();
  expect(root.closest(".pwa-root")).not.toBeNull();
  await expect.element(page.elementLocator(document.querySelector<HTMLElement>(".pwa-settings-drawer")!)).toBeVisible();
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialogElement.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialogElement.contains(document.activeElement)).toBe(true);
});

test("returns focus to the settings trigger after Close settings unmounts the Drawer", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SettingsHarness events={events} />);
  const { trigger, dialog } = await openSettings(screen);

  await screen.getByRole("button", { name: "Close settings" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("returns focus to the settings trigger after Escape unmounts the Drawer", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SettingsHarness events={events} />);
  const { trigger, dialog } = await openSettings(screen);

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("returns focus to the settings trigger after the Drawer overlay unmounts it", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SettingsHarness events={events} />);
  const { trigger, dialog } = await openSettings(screen);

  await drawerOverlay().click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("keeps focus in Settings when its parent rejects close", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SettingsHarness events={events} rejectClose />);
  const { trigger, dialog } = await openSettings(screen);
  const dialogElement = dialog.element();

  await screen.getByRole("button", { name: "Close settings" }).click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialogElement.contains(document.activeElement)).toBe(true);
  await expect.element(trigger).not.toHaveFocus();
  expect(events).toEqual(["close"]);
});

test("falls back to More options when the mobile Settings origin is hidden", async () => {
  const screen = await renderPwa(<SettingsHarness events={[]} mobileOrigin />);
  const moreOptions = screen.getByRole("button", { name: "More options" });
  await moreOptions.click();
  const mobileOrigin = screen.getByRole("button", { name: "Mobile settings" });
  const mobileOriginElement = mobileOrigin.element();
  mobileOriginElement.focus();
  await expect.element(mobileOrigin).toHaveFocus();
  await mobileOrigin.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  expect(mobileOriginElement.getClientRects()).toHaveLength(0);

  await screen.getByRole("button", { name: "Close settings" }).click();

  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(moreOptions).toHaveFocus();
});

test("forwards the raw relay value and prevents duplicate saves until its deferred callback settles", async () => {
  const savedValues: string[] = [];
  let settled = false;
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const screen = await renderPwa(
    <SettingsHarness
      events={[]}
      onSave={(value) => {
        savedValues.push(value);
        return pendingSave.then(() => { settled = true; });
      }}
    />,
  );
  await openSettings(screen);
  const input = screen.getByRole("textbox", { name: "Relay URL" });
  const rawValue = "  https://relay.changed.test/path/  ";

  await expect.element(input).toHaveValue(relayUrl);
  await expect.element(input).toHaveAttribute("placeholder", defaultRelayUrl);
  await input.fill(rawValue);
  const saveButton = screen.getByRole("button", { name: "Save settings" }).element();
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const attemptsBeforeSettling = savedValues.length;

  resolveSave();
  await expect.poll(() => settled).toBe(true);
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  expect(attemptsBeforeSettling).toBe(1);
  expect(savedValues).toEqual([rawValue, rawValue]);
});

test("closes only after a successful parent save, while Reset closes and Clear stays in the Drawer", async () => {
  const events: string[] = [];
  let saveSettled = false;
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const screen = await renderPwa(
    <SettingsHarness
      events={events}
      closeAfterSave
      onSave={() => pendingSave.then(() => { saveSettled = true; })}
    />,
  );
  const { dialog } = await openSettings(screen);

  await screen.getByRole("button", { name: "Save settings" }).click();
  await expect.element(dialog).toBeVisible();
  resolveSave();
  await expect.poll(() => saveSettled).toBe(true);
  await expect.element(dialog).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Open settings" }).click();
  const resetDialog = screen.getByRole("dialog");
  await screen.getByRole("button", { name: "Reset layout" }).click();
  await expect.element(resetDialog).not.toBeInTheDocument();
  expect(events).toEqual(["reset"]);

  await screen.getByRole("button", { name: "Open settings" }).click();
  const clearDialog = screen.getByRole("dialog");
  await screen.getByRole("button", { name: "Clear local data" }).click();
  await expect.element(clearDialog).toBeVisible();
  expect(document.querySelector(".pwa-confirm-dialog")).toBeNull();
  expect(events).toEqual(["reset", "clear"]);
});

test("keeps the mobile Settings Drawer in the viewport with scrollable content and reachable actions", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<SettingsHarness events={[]} />);
  const { dialog } = await openSettings(screen);
  const dialogElement = dialog.element();
  const body = document.querySelector<HTMLElement>(".pwa-settings-body");
  expect(body).not.toBeNull();

  const rect = dialogElement.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(dialogElement.scrollWidth).toBeLessThanOrEqual(dialogElement.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(getComputedStyle(body!).overflowY).toBe("visible");
  expect(getComputedStyle(dialogElement).overflowY).toBe("auto");

  const actions = [
    screen.getByRole("button", { name: "Close settings" }),
    screen.getByRole("button", { name: "Save settings" }),
    screen.getByRole("button", { name: "Reset layout" }),
    screen.getByRole("button", { name: "Clear local data" }),
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
