"use client";

import type { RefObject } from "react";
import { Select } from "@/components/ui";
import { Activity } from "lucide-react";
import { MessageComposer, type MessageComposerAttachment } from "@/components/pwa/message-composer";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { ConfirmActionDialog } from "@/components/pwa/confirm-action-dialog";
import type { ComposerCommandAction } from "@/components/pwa/composer-command-menu";
import { MessageList } from "@/components/pwa/message-list";
import { PairingDialog, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { MobileTopbarMenu } from "@/components/pwa/mobile-topbar-menu";
import { DesktopTopbarActions, PwaMessageActions, PwaStatusToast, SessionSwitcherTrigger } from "@/components/pwa/pwa-app-actions";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import { ConnectionStatus, DesktopSidebar, EmptyWorkspace, displayPeer, type ConnectionViewState, type PairingPresence } from "@/components/pwa/workspace-view";
import type { ThinkingLevel, WireModel } from "@/lib/remote-pi/types";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

export type ConfirmActionRequest =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string; peer: PwaPeerRecord }
  | { kind: "clear-local-data" };

export type PwaAppViewModel = {
  startup: {
    state: "loading" | "ready" | "error";
    error: StartupError | null;
  };
  status: {
    connection: ConnectionViewState;
    retryAttempt: number;
    error: string | null;
    layoutRevision: number;
  };
  workspace: {
    peers: PwaPeerRecord[];
    rooms: PwaRoomRecord[];
    activePeer: PwaPeerRecord | null;
    activePeerId: string | null;
    activeRoom: PwaRoomRecord | null;
    activeRooms: PwaRoomRecord[];
    roomId: string;
    pairingPresence: Record<string, PairingPresence>;
    lastSyncedLabel: string;
    lastSyncedDateTime: string | undefined;
  };
  timeline: {
    items: TimelineViewItem[];
    nextBefore: string | null;
    loadingEarlier: boolean;
    followingOutput: boolean;
    unreadOutput: number;
  };
  composer: {
    attachment: MessageComposerAttachment | null;
    canAttachImage: boolean;
    sendingImage: boolean;
    stopRequestId: string | null;
    draft: string;
    models: WireModel[];
    currentModel: WireModel | null;
    activeThinking: ThinkingLevel;
    pendingAction: ComposerCommandAction | null;
  };
  overlays: {
    pairState: "idle" | "scanning" | "pairing";
    sessionSheetRequest: { focusOrigin: HTMLElement | null } | null;
    renameRequest: {
      peer: PwaPeerRecord;
      focusOrigin: HTMLElement | null;
      focusFallbackSelectors: readonly string[];
    } | null;
    confirmAction: ConfirmActionRequest | null;
    confirmPending: boolean;
    confirmError: string | null;
  };
  settings: {
    request: {
      focusOrigin: HTMLElement | null;
      focusFallbackSelectors: readonly string[];
    } | null;
    relayUrl: string;
    defaultRelayUrl: string;
  };
};

export type PwaAppViewActions = {
  startup: {
    retry: () => void;
  };
  topbar: {
    refresh: () => void | Promise<unknown>;
    openSessionSheet: () => void;
    openSettings: () => void;
  };
  workspace: {
    startPairing: () => void;
    selectPeer: (peerId: string | null) => void;
    selectRoom: (roomId: string) => void;
    openRenamePeer: (peer: PwaPeerRecord) => void;
    removePeer: (peer: PwaPeerRecord) => void;
    clearLocalData: () => Promise<void>;
  };
  timeline: {
    loadEarlier: () => void;
    handleMessageListScroll: () => void;
    retryUnknownMessage: (clientRequestId: string) => void;
    cancelQueuedMessage: (clientRequestId: string) => void;
    restartConnection: (resetRetries: boolean) => void;
    showLatest: () => void;
  };
  composer: {
    setDraft: (draft: string) => void;
    sendMessage: () => Promise<void>;
    stopCurrentTask: () => void;
    setImageAttachment: (source: Blob, label: string) => void;
    clearAttachment: () => void;
    startNewSession: () => void;
    compactSession: () => void;
    setCommandModel: (model: WireModel) => void;
    setCommandThinking: (level: ThinkingLevel) => void;
    refreshModels: () => void;
  };
  overlays: {
    setPairState: (state: "idle" | "scanning" | "pairing") => void;
    pairFromQr: (raw: string) => Promise<void>;
    closeSessionSheet: () => void;
    savePeerNickname: (peer: PwaPeerRecord, nickname: string) => Promise<void>;
    closeRenamePeer: () => void;
    closeConfirmAction: () => void;
    confirmRequestedAction: () => Promise<void>;
    restoreConfirmFocus: () => void;
    dismissError: () => void;
  };
  settings: {
    saveRelayUrl: (value: string) => Promise<void>;
    closeSettings: () => void;
    resetLayout: () => void;
  };
};

export type PwaAppViewRefs = {
  messageListRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
};

export function PwaAppView({ viewModel, actions, refs }: { viewModel: PwaAppViewModel; actions: PwaAppViewActions; refs: PwaAppViewRefs }) {
  const { startup, status, workspace, timeline, composer, overlays, settings } = viewModel;

  // The parent owns all runtime state and feeds this view only presentation data.
  if (startup.state === "loading") return <StartupLoading />;
  if (startup.state === "error") return <StartupErrorView error={startup.error} onRetry={actions.startup.retry} />;

  return (
    <div className="pwa-root" key={status.layoutRevision}>
      <header className="pwa-topbar">
        <div className="pwa-brand"><span className="pwa-brand-mark">π</span><span>Remote Pi</span><span className="pwa-brand-tag">BROWSER APP</span></div>
        <div className="pwa-topbar-actions">
          <SessionSwitcherTrigger label={workspace.activePeer ? `Session: ${displayPeer(workspace.activePeer)} / ${workspace.roomId}` : null} expanded={overlays.sessionSheetRequest !== null} onOpen={actions.topbar.openSessionSheet} />
          <ConnectionStatus state={status.connection} retryAttempt={status.retryAttempt} />
          <DesktopTopbarActions onRefresh={actions.topbar.refresh} onToggleSettings={actions.topbar.openSettings} />
          <MobileTopbarMenu onRefresh={actions.topbar.refresh} onOpenSettings={actions.topbar.openSettings} />
        </div>
      </header>
      <div className="pwa-layout">
        <DesktopSidebar peers={workspace.peers} activePeerId={workspace.activePeerId} pairingPresence={workspace.pairingPresence} onPair={actions.workspace.startPairing} onSelect={actions.workspace.selectPeer} onRename={actions.workspace.openRenamePeer} onRemove={(peer) => void actions.workspace.removePeer(peer)} onClearData={actions.workspace.clearLocalData} />
        <main className="pwa-main">
          {workspace.activePeer ? <>
            <div className="pwa-chat-head"><div><span className="pwa-kicker">Active session</span><h2>{displayPeer(workspace.activePeer)}</h2><span className="pwa-chat-meta"><span className={status.connection === "online" ? "pwa-status-dot online" : "pwa-status-dot"} />{status.connection === "online" ? "Live" : "Local history"} <span className="pwa-separator">/</span> session <code>{workspace.roomId}</code> <span className="pwa-separator">/</span> last synced <time dateTime={workspace.lastSyncedDateTime}>{workspace.lastSyncedLabel}</time></span></div><div className="pwa-room-control"><Select id="room-id" label="Session" value={workspace.roomId} disabled={status.connection !== "online"} allowDeselect={false} data={[{ value: workspace.roomId, label: workspace.roomId }, ...workspace.activeRooms.filter((room) => room.roomId !== workspace.roomId).map((room) => ({ value: room.roomId, label: room.name || room.cwd || room.roomId }))]} onChange={(nextRoom) => { if (nextRoom !== null) actions.workspace.selectRoom(nextRoom); }} comboboxProps={{ withinPortal: false }} /></div></div>
            <MessageList items={timeline.items} hasEarlier={timeline.nextBefore !== null} loadingEarlier={timeline.loadingEarlier} onLoadEarlier={actions.timeline.loadEarlier} listRef={refs.messageListRef} bottomSentinelRef={refs.bottomSentinelRef} onScroll={actions.timeline.handleMessageListScroll} onRetryUnknown={actions.timeline.retryUnknownMessage} onCancelQueued={actions.timeline.cancelQueuedMessage} />
            <div className="pwa-chat-footer">
              <PwaMessageActions
                show={(status.connection !== "no_network" && (status.connection === "retrying" || status.connection === "offline")) || !timeline.followingOutput || timeline.unreadOutput > 0}
                showRetry={status.connection !== "no_network" && (status.connection === "retrying" || status.connection === "offline")}
                showLatest={!timeline.followingOutput || timeline.unreadOutput > 0}
                unreadOutput={timeline.unreadOutput}
                onRetry={() => actions.timeline.restartConnection(true)}
                onLatest={actions.timeline.showLatest}
              />
              <MessageComposer attachment={composer.attachment} canAttachImage={composer.canAttachImage} sendingImage={composer.sendingImage} isOnline={status.connection === "online"} isWorking={workspace.activeRoom?.working === true} stopping={composer.stopRequestId !== null} draft={composer.draft} onDraftChange={actions.composer.setDraft} onSend={actions.composer.sendMessage} onStop={actions.composer.stopCurrentTask} onSetAttachment={actions.composer.setImageAttachment} onClearAttachment={actions.composer.clearAttachment} commandModels={composer.models} commandCurrentModel={composer.currentModel} commandCurrentModelFallback={workspace.activeRoom?.model ?? null} commandThinking={composer.activeThinking} commandPendingAction={composer.pendingAction} onNewSession={actions.composer.startNewSession} onCompactSession={actions.composer.compactSession} onSetModel={actions.composer.setCommandModel} onSetThinking={actions.composer.setCommandThinking} onCommandsOpen={actions.composer.refreshModels} />
            </div>
          </> : <EmptyWorkspace onPair={actions.workspace.startPairing} />}
        </main>
        {settings.request ? <SettingsPanel relayUrl={settings.relayUrl} defaultRelayUrl={settings.defaultRelayUrl} onSave={actions.settings.saveRelayUrl} onClose={actions.settings.closeSettings} onClearData={actions.workspace.clearLocalData} onResetLayout={actions.settings.resetLayout} focusOrigin={settings.request.focusOrigin} focusFallbackSelectors={settings.request.focusFallbackSelectors} /> : null}
      </div>
      {overlays.sessionSheetRequest ? <SessionSheet peers={workspace.peers} rooms={workspace.rooms} activePeerId={workspace.activePeerId} activeRoomId={workspace.roomId} pairingPresence={workspace.pairingPresence} onSelectPeer={actions.workspace.selectPeer} onSelectRoom={actions.workspace.selectRoom} onPair={actions.workspace.startPairing} onRename={actions.workspace.openRenamePeer} onRemove={(peer) => void actions.workspace.removePeer(peer)} onClose={actions.overlays.closeSessionSheet} focusOrigin={overlays.sessionSheetRequest.focusOrigin} /> : null}
      {overlays.renameRequest ? <RenamePairingDialog peer={overlays.renameRequest.peer} onSave={(nickname) => actions.overlays.savePeerNickname(overlays.renameRequest!.peer, nickname)} onClose={actions.overlays.closeRenamePeer} focusOrigin={overlays.renameRequest.focusOrigin} focusFallbackSelectors={overlays.renameRequest.focusFallbackSelectors} /> : null}
      {overlays.pairState !== "idle" ? <div className="pwa-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && overlays.pairState === "scanning") actions.overlays.setPairState("idle"); }} role="presentation">{overlays.pairState === "scanning" ? <PairingDialog onScan={actions.overlays.pairFromQr} onClose={() => actions.overlays.setPairState("idle")} /> : <div className="pwa-pairing-card"><Activity className="pwa-spin" /><span className="pwa-kicker">Pairing</span><h2>Connecting to your Pi</h2><p>Waiting for the Pi to confirm this browser.</p></div>}</div> : null}
      <ConfirmActionDialog action={overlays.confirmAction?.kind === "remove-pairing" ? { kind: overlays.confirmAction.kind, label: overlays.confirmAction.label } : overlays.confirmAction} pending={overlays.confirmPending} error={overlays.confirmError} onConfirm={() => { void actions.overlays.confirmRequestedAction(); }} onClose={actions.overlays.closeConfirmAction} onExitTransitionEnd={actions.overlays.restoreConfirmFocus} />
      <PwaStatusToast message={status.error} onDismiss={actions.overlays.dismissError} />
    </div>
  );
}
