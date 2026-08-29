"use client";

import { useRef, useState } from "react";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "@/components/pwa/confirm-action-dialog";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import { canCloseBackgroundOverlay, pickConfirmationFocusFallback } from "@/components/pwa/pwa-app";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

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
  const closeConfirm = () => {
    setConfirmAction(null);
  };
  const completeConfirmExit = () => {
    confirmOpenRef.current = false;
    setConfirmTransition("exited");
  };

  return (
    <>
      <span data-testid="settings-confirm-transition" data-state={confirmTransition} hidden />
      {settingsOpen ? <SettingsPanel relayUrl="https://relay.example.test" defaultRelayUrl="https://relay.default.test" onSave={async () => {}} onClose={closeSettings} onClearData={async () => requestClear()} onResetLayout={() => {}} /> : null}
      <ConfirmActionDialog action={confirmAction} pending={false} onConfirm={() => {}} onClose={closeConfirm} onExitTransitionEnd={completeConfirmExit} />
    </>
  );
}

const sessionPeer: PwaPeerRecord = {
  id: "peer:main",
  remoteEpk: "e5FRoCabBqVX",
  sessionName: "XCrawl#2",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
};
const sessionRooms: PwaRoomRecord[] = [
  { id: "peer:main", peerEpk: sessionPeer.remoteEpk, roomId: "main", cwd: "/work/remote-pi", online: true, updatedAt: 1 },
];

export function SessionConfirmHarness() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [peers, setPeers] = useState<PwaPeerRecord[]>([sessionPeer]);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction | null>(null);
  const [confirmTransition, setConfirmTransition] = useState<"idle" | "opening" | "exited">("idle");
  const confirmOpenRef = useRef(false);
  const confirmFocusOriginRef = useRef<HTMLElement | null>(null);
  const confirmFallbackSelectors = [
    'button[aria-label="Close sessions"]',
    ".pwa-session-sheet .pwa-sheet-peer-select",
    'button[aria-label="Open session switcher"]',
  ];

  const requestRemove = (peer: PwaPeerRecord) => {
    confirmOpenRef.current = true;
    setConfirmTransition("opening");
    confirmFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmAction({ kind: "remove-pairing", label: `${peer.sessionName} / ${peer.roomId}` });
  };
  const closeSheet = () => {
    if (canCloseBackgroundOverlay(confirmOpenRef.current, false)) setSheetOpen(false);
  };
  const closeConfirm = () => {
    setConfirmAction(null);
  };
  const confirmRemove = () => {
    setPeers([]);
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
      {sheetOpen ? <SessionSheet peers={peers} rooms={sessionRooms} activePeerId={sessionPeer.id} activeRoomId="main" onSelectPeer={() => {}} onSelectRoom={() => {}} onPair={() => {}} onRename={() => {}} onRemove={requestRemove} onClose={closeSheet} /> : null}
      <ConfirmActionDialog action={confirmAction} pending={false} onConfirm={confirmRemove} onClose={closeConfirm} onExitTransitionEnd={restoreFocus} />
    </>
  );
}
