import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SettingsConfirmHarness, SessionConfirmHarness } from "@/test/browser/fixtures/confirm-action-overlays";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "./confirm-action-dialog";

type ConfirmHarnessProps = {
  action?: ConfirmActionDialogAction;
  onConfirm: () => Promise<void>;
};

function ConfirmHarness({ action: nextAction = { kind: "new-session" }, onConfirm }: ConfirmHarnessProps) {
  const [action, setAction] = useState<ConfirmActionDialogAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void onConfirm()
      .then(() => setAction(null))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Confirmation failed.");
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <button type="button" onClick={() => { setError(null); setAction(nextAction); }}>
        Open confirmation
      </button>
      <ConfirmActionDialog
        action={action}
        pending={pending}
        error={error}
        onConfirm={confirm}
        onClose={() => setAction(null)}
      />
    </>
  );
}

const noOpConfirm = async () => {};

beforeEach(async () => {
  await page.viewport(1280, 900);
});

async function openConfirmation(action?: ConfirmActionDialogAction, onConfirm = noOpConfirm) {
  const screen = await renderPwa(<ConfirmHarness action={action} onConfirm={onConfirm} />);
  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  return { screen, trigger, dialog };
}

test("keeps one mounted dialog instance through closed, open, and closed states", async () => {
  const screen = await renderPwa(<ConfirmHarness onConfirm={noOpConfirm} />);
  const dialog = screen.getByRole("dialog");
  const trigger = screen.getByRole("button", { name: "Open confirmation" });

  await expect.element(dialog).not.toBeInTheDocument();
  await trigger.click();
  await expect.element(dialog).toBeVisible();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});

test("renders an accessible dialog and closes through Cancel and Escape", async () => {
  const { screen, dialog } = await openConfirmation();

  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  const dialogElement = dialog.element();
  const labelledBy = dialogElement.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(document.getElementById(labelledBy!)?.textContent).toContain("Start a fresh session?");
  const describedBy = dialogElement.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toContain("All Owners on this endpoint will switch to a fresh session.");
  await expect.element(screen.getByRole("heading", { name: "Start a fresh session?", exact: true })).toBeVisible();
  await expect.element(screen.getByText("All Owners on this endpoint will switch to a fresh session.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Start fresh session" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Close confirmation dialog" })).toBeVisible();

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  await trigger.click();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("traps focus in the dialog and returns it to the explicit trigger after closing", async () => {
  const screen = await renderPwa(<ConfirmHarness onConfirm={noOpConfirm} />);
  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialog.element().contains(document.activeElement)).toBe(true);

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("locks every close path while confirmation is pending", async () => {
  let resolveConfirmation!: () => void;
  const pendingConfirmation = new Promise<void>((resolve) => {
    resolveConfirmation = resolve;
  });
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" }, () => pendingConfirmation);

  await screen.getByRole("button", { name: "Clear local data" }).click();
  const pendingConfirm = screen.getByRole("button", { name: /Clearing local data/ });
  await expect.element(pendingConfirm).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Close confirmation dialog" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toBeVisible();
  const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(overlay).not.toBeNull();
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(dialog).toBeVisible();

  resolveConfirmation();
  await expect.element(dialog).not.toBeInTheDocument();
});

test("keeps the dialog open on error and permits a retry", async () => {
  let attempts = 0;
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" }, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Storage is unavailable.");
  });

  await screen.getByRole("button", { name: "Clear local data" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Storage is unavailable.");
  await expect.element(dialog).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Clear local data" })).toBeEnabled();

  await screen.getByRole("button", { name: "Clear local data" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(attempts).toBe(2);
});

test("applies the PWA mobile layout without clipping action content", async () => {
  await page.viewport(390, 844);
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" });
  const dialogElement = dialog.element();
  const actions = document.querySelector<HTMLElement>(".pwa-confirm-actions");
  expect(actions).not.toBeNull();

  const dialogRect = dialogElement.getBoundingClientRect();
  expect(dialogRect.left).toBeGreaterThanOrEqual(0);
  expect(dialogRect.top).toBeGreaterThanOrEqual(0);
  expect(dialogRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(dialogRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(dialogElement.scrollWidth).toBeLessThanOrEqual(dialogElement.clientWidth);
  expect(getComputedStyle(actions!).flexDirection).toBe("column");

  const buttons = [...actions!.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons).toHaveLength(2);
  expect(buttons[0].getBoundingClientRect().width).toBe(buttons[1].getBoundingClientRect().width);
  for (const button of buttons) {
    expect(button.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
  }

  await expect.element(screen.getByRole("heading", { name: "Clear this browser's Remote Pi identity, pairings, and history?", exact: true })).toBeVisible();
  await expect.element(screen.getByText("This cannot be undone.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Clear local data" })).toBeVisible();
});

function locatorFor(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return page.elementLocator(element!);
}

test("keeps the Settings Drawer open for the first Escape and above the confirmation Modal", async () => {
  const screen = await renderPwa(<SettingsConfirmHarness />);
  const drawer = locatorFor(".pwa-settings-drawer");
  const clearButton = screen.getByRole("button", { name: "Clear local data" }).first();
  await expect.element(drawer).toBeVisible();

  await clearButton.click();
  const dialog = locatorFor(".pwa-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  const modalRoot = document.querySelector<HTMLElement>(".mantine-Modal-root");
  const drawerRoot = document.querySelector<HTMLElement>(".mantine-Drawer-root");
  expect(modalRoot).not.toBeNull();
  expect(drawerRoot).not.toBeNull();
  expect(modalRoot!.closest(".pwa-root")).not.toBeNull();
  expect(drawerRoot!.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(modalRoot!).getPropertyValue("--mb-z-index")).toBe("310");
  expect(getComputedStyle(drawerRoot!).getPropertyValue("--mb-z-index")).toBe("200");

  const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(overlay).not.toBeNull();
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("settings-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();

  await clearButton.click();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("settings-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(clearButton).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(drawer).not.toBeInTheDocument();
});

test("keeps the Endpoint Drawer open and falls back to its close button after the trigger is removed", async () => {
  const screen = await renderPwa(<SessionConfirmHarness />);
  const drawer = locatorFor(".pwa-session-sheet");
  const closeButton = screen.getByRole("button", { name: "Close endpoints" });
  const deleteButton = screen.getByRole("button", { name: /Delete Pi on office/ });
  const drawerRoot = document.querySelector<HTMLElement>(".mantine-Drawer-root");
  expect(drawerRoot).not.toBeNull();
  expect(drawerRoot!.closest(".pwa-root")).not.toBeNull();
  await expect.element(drawer).toBeVisible();

  await deleteButton.click();
  let dialog = locatorFor(".pwa-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(deleteButton).toHaveFocus();

  await deleteButton.click();
  dialog = locatorFor(".pwa-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(deleteButton).toHaveFocus();

  await deleteButton.click();
  dialog = locatorFor(".pwa-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  await screen.getByRole("button", { name: "Delete pairing" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(deleteButton).not.toBeInTheDocument();
  await expect.element(closeButton).toHaveFocus();
});
