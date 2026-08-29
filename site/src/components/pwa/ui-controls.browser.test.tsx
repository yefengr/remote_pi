import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { Select } from "@/components/ui";
import { DesktopSidebar } from "./workspace-view";

function SelectHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("main");
  return (
    <Select
      aria-label="Session"
      value={value}
      disabled={disabled}
      data={[
        { value: "main", label: "Main session" },
        { value: "review", label: "Review session" },
      ]}
      onChange={(next) => { if (next) setValue(next); }}
      comboboxProps={{ withinPortal: false }}
    />
  );
}

test("Select opens with the keyboard and selects an option", async () => {
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Session" });

  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  const review = screen.getByRole("option", { name: "Review session" });
  await expect.element(review).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(select).toHaveValue("Review session");
});

test("disabled Select does not open", async () => {
  const screen = await renderPwa(<SelectHarness disabled />);
  const select = screen.getByRole("combobox", { name: "Session" });

  await expect.element(select).toBeDisabled();
  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByRole("option", { name: "Review session" })).not.toBeInTheDocument();
});

test("Select remains within a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Session" });
  const rect = select.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("the desktop pairing action remains a round 44px target", async () => {
  await page.viewport(1280, 720);
  await renderPwa(
    <DesktopSidebar
      peers={[]}
      activePeerId={null}
      onPair={() => {}}
      onSelect={() => {}}
      onRename={() => {}}
      onRemove={() => {}}
      onClearData={async () => {}}
    />,
  );
  const roundAction = document.querySelector<HTMLButtonElement>(".pwa-round-button");
  expect(roundAction).not.toBeNull();
  if (!roundAction) return;

  const rect = roundAction.getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(window.getComputedStyle(roundAction).borderRadius).toBe("50%");
});
