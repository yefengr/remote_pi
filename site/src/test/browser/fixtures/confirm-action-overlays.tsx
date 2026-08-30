"use client";

import { useRef, useState } from "react";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "@/components/pwa/confirm-action-dialog";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import { canCloseBackgroundOverlay, pickConfirmationFocusFallback } from "@/components/pwa/pwa-app";
import { displayDevice } from "@/components/pwa/workspace-view";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

export function SettingsConfirmHarness() {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction | null>(null);
  const [confirmTransition, setConfirmTransition] = useState<"idle" | "opening" | "exited">("idle");
  const confirmOpenRef = useRef(false);

  const requestClear = () => {
    confirmOpenRef.current = true;
    setConfirmTransition("opening");
    setConfirmAction({ kind: "clear-local-data" });
  };
  const closeSettings = () => {
    if (canCloseBackgroundOverlay(confirmOpenRef.current, false)) setSettingsOpen(false);
  };
  return (
    <>
      <span data-testid="settings-confirm-transition" data-state={confirmTransition} hidden />
      {settingsOpen ? <SettingsPanel relayUrl="https://relay.example.test" defaultRelayUrl="https://relay.default.test" onSave={async () => {}} onClose={closeSettings} onClearData={async () => requestClear()} onResetLayout={() => {}} /> : null}
      <ConfirmActionDialog
        action={confirmAction}
        pending={false}
        onConfirm={() => {}}
        onClose={() => setConfirmAction(null)}
        onExitTransitionEnd={() => { confirmOpenRef.current = false; setConfirmTransition("exited"); }}
      />
    </>
  );
}

const sessionDevice: PwaDeviceRecord = {
  id: "device:office",
  deviceId: "device-office-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};
const sessionEndpoints: PwaEndpointRecord[] = [
  { id: "endpoint:daemon", deviceId: sessionDevice.deviceId, endpointId: "endpoint-daemon", runtimeInstanceId: "runtime-daemon", kind: "daemon", name: "Office daemon", cwd: "/work/remote-pi", online: true, updatedAt: 1 },
  { id: "endpoint:interactive", deviceId: sessionDevice.deviceId, endpointId: "endpoint-interactive", runtimeInstanceId: "runtime-interactive", kind: "interactive", name: "Office interactive", cwd: "/work/remote-pi", online: false, updatedAt: 2 },
];

export function SessionConfirmHarness() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([sessionDevice]);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction | null>(null);
  const [confirmTransition, setConfirmTransition] = useState<"idle" | "opening" | "exited">("idle");
  const confirmOpenRef = useRef(false);
  const confirmFocusOriginRef = useRef<HTMLElement | null>(null);
  const confirmFallbackSelectors = [
    'button[aria-label="Close endpoints"]',
    ".pwa-session-sheet .pwa-sheet-peer-select",
    'button[aria-label="Open endpoint switcher"]',
  ];

  const requestRemove = (device: PwaDeviceRecord) => {
    confirmOpenRef.current = true;
    setConfirmTransition("opening");
    confirmFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmAction({ kind: "remove-pairing", label: displayDevice(device) });
  };
  const closeSheet = () => {
    if (canCloseBackgroundOverlay(confirmOpenRef.current, false)) setSheetOpen(false);
  };
  const confirmRemove = () => {
    setDevices([]);
    setConfirmAction(null);
  };
  const restoreFocus = () => {
    const dialog = document.querySelector<HTMLElement>(".pwa-confirm-dialog");
    const candidates = [
      confirmFocusOriginRef.current,
      ...confirmFallbackSelectors.map((selector) => document.querySelector<HTMLElement>(selector)),
    ];
    const fallback = pickConfirmationFocusFallback(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
      candidates,
      (element) => element !== document.body && element !== document.documentElement && !dialog?.contains(element),
      (element) => element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'),
    );
    fallback?.focus({ preventScroll: true });
    confirmOpenRef.current = false;
    confirmFocusOriginRef.current = null;
    setConfirmTransition("exited");
  };

  return (
    <>
      <span data-testid="session-confirm-transition" data-state={confirmTransition} hidden />
      {sheetOpen ? <SessionSheet devices={devices} endpoints={sessionEndpoints} activeDeviceId={sessionDevice.id} activeEndpointId="endpoint-daemon" pairingPresence={{ [sessionDevice.id]: { status: "partial", onlineEndpoints: 1, totalEndpoints: 2 } }} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onPair={() => {}} onRename={() => {}} onRemove={requestRemove} onClose={closeSheet} /> : null}
      <ConfirmActionDialog action={confirmAction} pending={false} onConfirm={confirmRemove} onClose={() => setConfirmAction(null)} onExitTransitionEnd={restoreFocus} />
    </>
  );
}
