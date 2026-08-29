import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { RenamePairingDialog } from "./rename-pairing-dialog";
import { renderPwa } from "@/test/browser/render";
import { SessionRenameHarness } from "@/test/browser/fixtures/rename-pairing-dialog";
import type { PwaPeerRecord } from "@/lib/pwa/db";

const peer: PwaPeerRecord = {
  id: "peer:main",
  remoteEpk: "e5FRoCabBqVX",
  sessionName: "XCrawl#2",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
  hostname: "office",
};

type RenameHarnessProps = {
  onSave: (nickname: string) => Promise<void>;
  onDialogClose?: () => void;
};

function RenameHarness({ onSave, onDialogClose = () => {} }: RenameHarnessProps) {
  const [opened, setOpened] = useState(false);
  const closeDialog = () => {
    onDialogClose();
    setOpened(false);
  };

  return (
    <>
      <button type="button" onClick={() => setOpened(true)}>
        Open rename
      </button>
      <button type="button" data-testid="force-unmount-rename" hidden onClick={() => setOpened(false)} />
      <button type="button" data-testid="double-submit-rename" hidden onClick={() => {
        const form = document.querySelector<HTMLFormElement>(".pwa-rename-dialog form");
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      }} />
      {opened ? <RenamePairingDialog peer={peer} onSave={onSave} onClose={closeDialog} /> : null}
    </>
  );
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

const noOpSave: (nickname: string) => Promise<void> = async () => {};

async function openRename(onSave: (nickname: string) => Promise<void> = noOpSave) {
  const screen = await renderPwa(<RenameHarness onSave={onSave} />);
  const trigger = screen.getByRole("button", { name: "Open rename" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  return { screen, trigger, dialog };
}

test("renders an accessible in-root dialog and focuses the preselected suggested name", async () => {
  const { screen, dialog } = await openRename();
  const input = screen.getByRole("textbox", { name: "Pairing name" });
  const dialogElement = dialog.element();

  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialogElement.closest(".pwa-root")).not.toBeNull();
  const labelledBy = dialogElement.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(document.getElementById(labelledBy!)?.textContent).toContain("Rename pairing");
  const describedBy = dialogElement.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toContain("This only changes the label in this browser.");
  await expect.element(screen.getByRole("heading", { name: "Rename pairing", exact: true })).toBeVisible();
  await expect.element(input).toHaveValue("Pi on office");
  await expect.element(input).toHaveFocus();
  const inputElement = input.element() as HTMLInputElement;
  await expect.poll(() => [inputElement.selectionStart, inputElement.selectionEnd]).toEqual([0, "Pi on office".length]);
});

test("submits a trimmed name with Enter, closes, and returns focus", async () => {
  const savedNames: string[] = [];
  const { screen, trigger, dialog } = await openRename(async (nickname) => {
    savedNames.push(nickname);
  });
  const input = screen.getByRole("textbox", { name: "Pairing name" });

  await input.fill("  Desk Pi  ");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog).not.toBeInTheDocument();
  expect(savedNames).toEqual(["Desk Pi"]);
  await expect.element(trigger).toHaveFocus();
});

test("closes through Cancel and Escape and returns focus", async () => {
  const { screen, trigger, dialog } = await openRename();

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  const reopenedDialog = screen.getByRole("dialog");
  await expect.element(reopenedDialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(reopenedDialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("locks close paths and duplicate submissions while saving", async () => {
  let attempts = 0;
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const { screen, trigger, dialog } = await openRename(() => {
    attempts += 1;
    return pendingSave;
  });

  screen.getByTestId("double-submit-rename").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(attempts).toBe(1);
  await expect.element(screen.getByRole("textbox", { name: "Pairing name" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Close rename dialog" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(overlay).not.toBeNull();
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toBeVisible();
  expect(attempts).toBe(1);

  resolveSave();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(attempts).toBe(1);
  await expect.element(trigger).toHaveFocus();
});

test("ignores a pending save result after the parent unmounts the dialog", async () => {
  let resolveSave!: () => void;
  let saveSettled = false;
  let closeCalls = 0;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const screen = await renderPwa(<RenameHarness onSave={() => pendingSave.then(() => { saveSettled = true; })} onDialogClose={() => { closeCalls += 1; }} />);
  await screen.getByRole("button", { name: "Open rename" }).click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await screen.getByRole("button", { name: "Save" }).click();

  screen.getByTestId("force-unmount-rename").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(dialog).not.toBeInTheDocument();
  resolveSave();
  await expect.poll(() => saveSettled).toBe(true);
  expect(closeCalls).toBe(0);
});

test("returns Session Drawer rename flows to the persistent session switcher", async () => {
  const screen = await renderPwa(<SessionRenameHarness />);
  const switcher = screen.getByRole("button", { name: "Open session switcher" });

  const openFromDrawer = async () => {
    await switcher.click();
    await expect.poll(() => document.querySelector(".pwa-session-sheet") !== null).toBe(true);
    const drawerElement = document.querySelector<HTMLElement>(".pwa-session-sheet");
    expect(drawerElement).not.toBeNull();
    const drawer = page.elementLocator(drawerElement!);
    await expect.element(drawer).toBeVisible();
    await screen.getByRole("button", { name: "Rename Pi on office" }).click();
    await expect.element(drawer).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Rename pairing" });
    await expect.element(dialog).toBeVisible();
    return dialog;
  };

  let dialog = await openFromDrawer();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(switcher).toHaveFocus();

  dialog = await openFromDrawer();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(switcher).toHaveFocus();

  dialog = await openFromDrawer();
  await screen.getByRole("button", { name: "Close rename dialog" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(switcher).toHaveFocus();

  dialog = await openFromDrawer();
  await screen.getByRole("button", { name: "Save" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(switcher).toHaveFocus();
});

test("keeps the dialog open after a save error and permits a retry", async () => {
  let attempts = 0;
  const { screen, dialog } = await openRename(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Storage is unavailable.");
  });

  await screen.getByRole("button", { name: "Save" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Could not save this pairing name. Try again.");
  await expect.element(dialog).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();

  await screen.getByRole("button", { name: "Save" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(attempts).toBe(2);
});
