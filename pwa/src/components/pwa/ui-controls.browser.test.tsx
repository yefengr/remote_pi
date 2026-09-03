import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { Select } from "@/components/ui";
import { DesktopSidebar } from "./workspace-view";

function SelectHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("endpoint-main");
  return (
    <Select
      aria-label="Endpoint"
      value={value}
      disabled={disabled}
      data={[
        { value: "endpoint-main", label: "Main endpoint" },
        { value: "endpoint-review", label: "Review endpoint" },
      ]}
      onChange={(next) => { if (next) setValue(next); }}
      comboboxProps={{ withinPortal: false }}
    />
  );
}

test("Select opens with the keyboard and selects an option", async () => {
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });

  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  const review = screen.getByRole("option", { name: "Review endpoint" });
  await expect.element(review).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(select).toHaveValue("Review endpoint");
});

test("disabled Select does not open", async () => {
  const screen = await renderPwa(<SelectHarness disabled />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });

  await expect.element(select).toBeDisabled();
  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByRole("option", { name: "Review endpoint" })).not.toBeInTheDocument();
});

test("Select remains within a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });
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
      devices={[]}
      activeDeviceId={null}
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
