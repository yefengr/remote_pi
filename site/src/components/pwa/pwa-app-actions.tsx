"use client";

import { ActionIcon, Button } from "@mantine/core";
import { ArrowDownToLine, MessageSquare, RefreshCw, Settings, X } from "lucide-react";

type SessionSwitcherTriggerProps = {
  label: string | null;
  expanded: boolean;
  onOpen: () => void;
};

type DesktopTopbarActionsProps = {
  onRefresh: () => void | Promise<unknown>;
  onToggleSettings: () => void;
};

type MessageActionsProps = {
  show: boolean;
  showRetry: boolean;
  showLatest: boolean;
  unreadOutput: number;
  onRetry: () => void;
  onLatest: () => void;
};

type StatusToastProps = {
  message: string | null;
  onDismiss: () => void;
};

export function SessionSwitcherTrigger({ label, expanded, onOpen }: SessionSwitcherTriggerProps) {
  if (!label) return null;

  return (
    <Button
      className="pwa-session-trigger"
      type="button"
      variant="subtle"
      onClick={onOpen}
      aria-label="Open session switcher"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      leftSection={<MessageSquare size={16} />}
    >
      {label}
    </Button>
  );
}

export function DesktopTopbarActions({ onRefresh, onToggleSettings }: DesktopTopbarActionsProps) {
  return (
    <div className="pwa-desktop-actions">
      <ActionIcon className="pwa-icon-button" type="button" variant="subtle" size={44} onClick={() => { void onRefresh(); }} aria-label="Refresh app" title="Refresh app">
        <RefreshCw size={18} />
      </ActionIcon>
      <ActionIcon className="pwa-icon-button" type="button" variant="subtle" size={44} onClick={onToggleSettings} aria-label="Open settings" title="Settings">
        <Settings size={18} />
      </ActionIcon>
    </div>
  );
}

export function PwaMessageActions({ show, showRetry, showLatest, unreadOutput, onRetry, onLatest }: MessageActionsProps) {
  if (!show || (!showRetry && !showLatest)) return null;

  return (
    <div className="pwa-message-actions">
      {showRetry ? <Button className="pwa-latest-button" type="button" variant="subtle" leftSection={<RefreshCw size={16} />} onClick={onRetry}>Try again</Button> : null}
      {showLatest ? <Button className="pwa-latest-button" type="button" variant="subtle" leftSection={<ArrowDownToLine size={16} />} onClick={onLatest}>{unreadOutput > 0 ? `${unreadOutput} new output` : "Latest"}</Button> : null}
    </div>
  );
}

export function PwaStatusToast({ message, onDismiss }: StatusToastProps) {
  if (!message) return null;

  return (
    <div className="pwa-toast" role="status">
      <span>{message}</span>
      <ActionIcon className="pwa-toast-dismiss" type="button" variant="subtle" size={44} onClick={onDismiss} aria-label="Dismiss">
        <X size={15} />
      </ActionIcon>
    </div>
  );
}
