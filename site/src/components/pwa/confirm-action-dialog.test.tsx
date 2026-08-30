import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement } from "react";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "./confirm-action-dialog";
import { canCloseBackgroundOverlay, pickConfirmationFocusFallback, runConfirmAction, type ConfirmActionRequest } from "./pwa-app";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

function render(action: ConfirmActionDialogAction, pending = false): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <ConfirmActionDialog action={action} pending={pending} onConfirm={() => {}} onClose={() => {}} withinPortal={false} />
    </PwaUiProvider>,
  );
}

function buttonByClass(html: string, className: string): string {
  const match = html.match(new RegExp(`<button(?=[^>]*type="button")(?=[^>]*${className})[^>]*>[\\s\\S]*?<\\/button>`));
  assert.ok(match, `expected one ${className} button`);
  return match[0];
}

function confirmButton(html: string): string {
  const match = html.match(/<button(?=[^>]*type="button")(?=[^>]*data-tone="(?:primary|danger)")[^>]*>[\s\S]*?<\/button>/);
  assert.ok(match, "expected one confirmation button");
  return match[0];
}

test("keeps a closed modal mounted so Mantine can observe the opened transition", () => {
  const closedDialog = ConfirmActionDialog({ action: null, pending: false, onConfirm: () => {}, onClose: () => {}, withinPortal: false });
  assert.ok(isValidElement<{ opened: boolean }>(closedDialog));
  assert.equal(closedDialog.props.opened, false);

  const html = renderToStaticMarkup(<PwaUiProvider>{closedDialog}</PwaUiProvider>);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /pwa-confirm-dialog/);

  const appSource = readFileSync(new URL("./pwa-app.tsx", import.meta.url), "utf8");
  assert.match(appSource, /^\s*<ConfirmActionDialog action=/m);
  assert.doesNotMatch(appSource, /\{\s*confirmAction\s*\?\s*<ConfirmActionDialog/);
});

test("uses focus fallbacks only when Mantine cannot keep an active element", () => {
  const original = { id: "original", valid: false };
  const firstFallback = { id: "first", valid: true };
  const secondFallback = { id: "second", valid: true };
  const active = { id: "active", valid: true };
  const shouldKeepActive = (element: typeof active) => element.valid;
  const canFocus = (element: typeof active) => element.valid;

  assert.equal(pickConfirmationFocusFallback(active, [original, firstFallback], shouldKeepActive, canFocus), null);
  assert.equal(pickConfirmationFocusFallback(null, [original, firstFallback, secondFallback], shouldKeepActive, canFocus), firstFallback);
  assert.equal(pickConfirmationFocusFallback(null, [original, null], shouldKeepActive, canFocus), null);
});

test("keeps background drawers open while a confirmation is active", () => {
  assert.equal(canCloseBackgroundOverlay(true, false), false);
  assert.equal(canCloseBackgroundOverlay(false, true), false);
  assert.equal(canCloseBackgroundOverlay(false, false), true);
});

test("renders each confirmation action as an accessible Mantine modal", () => {
  const cases: Array<{ action: ConfirmActionDialogAction; title: string; description: string; confirmLabel: string }> = [
    { action: { kind: "new-session" }, title: "Start a fresh session?", description: "All Owners on this endpoint will switch to a fresh session.", confirmLabel: "Start fresh session" },
    { action: { kind: "remove-pairing", label: "Pi on office / interactive" }, title: "Delete pairing for Pi on office / interactive?", description: "This removes this device pairing, its endpoints, and local history from this browser.", confirmLabel: "Delete pairing" },
    { action: { kind: "clear-local-data" }, title: "Clear this browser&#x27;s Remote Pi identity, pairings, and history?", description: "This cannot be undone.", confirmLabel: "Clear local data" },
  ];

  for (const scenario of cases) {
    const html = render(scenario.action);
    assert.match(html, /mantine-Modal-content/);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="pwa-confirm-action-title"/);
    assert.match(html, /aria-describedby="pwa-confirm-action-description"/);
    assert.match(html, new RegExp(scenario.title.replace(/[?]/g, "\\?")));
    assert.match(html, new RegExp(scenario.description.replace(/[?]/g, "\\?")));
    assert.match(buttonByClass(html, "pwa-button"), /Cancel/);
    assert.match(confirmButton(html), new RegExp(scenario.confirmLabel));
    assert.match(html, /aria-label="Close confirmation dialog"/);
    assert.match(html, /title="Close confirmation dialog"/);
    assert.match(html, /type="button"/);
  }
});

test("uses a primary confirmation only for a new session", () => {
  const newSessionConfirm = confirmButton(render({ kind: "new-session" }));
  assert.match(newSessionConfirm, /data-tone="primary"/);
  assert.doesNotMatch(newSessionConfirm, /data-tone="danger"/);

  for (const action of [{ kind: "remove-pairing", label: "Pi on office / interactive" } as const, { kind: "clear-local-data" } as const]) {
    const html = render(action);
    const matches = html.match(/<button(?=[^>]*type="button")(?=[^>]*data-tone="danger")[^>]*>[\s\S]*?<\/button>/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(matches[0], /data-tone="danger"/);
  }
});

test("locks all close paths while an action is pending", () => {
  const html = render({ kind: "clear-local-data" }, true);
  const pendingConfirm = confirmButton(html);
  assert.match(pendingConfirm, /disabled=""/);
  assert.match(pendingConfirm, /Clearing local data…/);
  assert.match(buttonByClass(html, "pwa-button"), /disabled=""/);
  assert.match(buttonByClass(html, "pwa-button"), /Cancel/);
  assert.match(html, /aria-label="Close confirmation dialog"[^>]*disabled=""/);
});

const device: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "device-main",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};

function actionHarness(overrides: Partial<{
  startNewSession: () => boolean;
  removePairing: (target: PwaDeviceRecord) => Promise<void>;
  invalidateConnection: () => void;
  clearLocalData: () => Promise<void>;
  reload: () => void;
}> = {}) {
  const pendingRef = { current: false };
  const pending: boolean[] = [];
  const errors: Array<string | null> = [];
  let successes = 0;
  return {
    pendingRef,
    pending,
    errors,
    successes: () => successes,
    effects: {
      startNewSession: () => true,
      removePairing: async () => {},
      invalidateConnection: () => {},
      clearLocalData: async () => {},
      reload: () => {},
      ...overrides,
    },
    state: {
      pendingRef,
      setPending: (value: boolean) => pending.push(value),
      setError: (value: string | null) => errors.push(value),
      onSuccess: () => { successes += 1; },
    },
  };
}

test("runs a remove-pairing confirmation once while concurrent confirms are locked", async () => {
  let releaseRemoval = () => {};
  const removal = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  let removals = 0;
  const harness = actionHarness({ removePairing: async () => { removals += 1; await removal; } });
  const action: ConfirmActionRequest = { kind: "remove-pairing", label: "Pi on office / interactive", device };

  const first = runConfirmAction(action, harness.effects, harness.state);
  const second = await runConfirmAction(action, harness.effects, harness.state);
  releaseRemoval();

  assert.equal(second, "ignored");
  assert.equal(await first, "completed");
  assert.equal(removals, 1);
  assert.equal(harness.successes(), 1);
  assert.deepEqual(harness.pending, [true, false]);
  assert.deepEqual(harness.errors, [null]);
  assert.equal(harness.pendingRef.current, false);
});

test("keeps the confirmation open with an error when starting a session is rejected", async () => {
  const harness = actionHarness({ startNewSession: () => false });

  const result = await runConfirmAction({ kind: "new-session" }, harness.effects, harness.state);

  assert.equal(result, "failed");
  assert.equal(harness.successes(), 0);
  assert.deepEqual(harness.pending, [true, false]);
  assert.deepEqual(harness.errors, [null, "Could not start a fresh session. Check the connection and try again."]);
});

test("keeps a failed remove confirmation available for retry", async () => {
  const harness = actionHarness({ removePairing: async () => { throw new Error("Could not delete pairing."); } });

  const result = await runConfirmAction({ kind: "remove-pairing", label: "Pi on office / interactive", device }, harness.effects, harness.state);

  assert.equal(result, "failed");
  assert.equal(harness.successes(), 0);
  assert.deepEqual(harness.errors, [null, "Could not delete pairing."]);
  assert.equal(harness.pendingRef.current, false);
});

test("invalidates, clears, and reloads local data in order", async () => {
  const effects: string[] = [];
  const harness = actionHarness({
    invalidateConnection: () => effects.push("invalidate"),
    clearLocalData: async () => { effects.push("clear"); },
    reload: () => effects.push("reload"),
  });

  const result = await runConfirmAction({ kind: "clear-local-data" }, harness.effects, harness.state);

  assert.equal(result, "completed");
  assert.deepEqual(effects, ["invalidate", "clear", "reload"]);
  assert.equal(harness.successes(), 0);
  assert.deepEqual(harness.pending, [true, false]);
});
