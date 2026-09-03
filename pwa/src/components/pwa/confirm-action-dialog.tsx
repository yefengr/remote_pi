"use client";

import { Group, Modal, Stack, Text } from "@mantine/core";
import { Button, type ButtonTone } from "@/components/ui";

export type ConfirmActionDialogAction =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string }
  | { kind: "clear-local-data" };

type ConfirmActionDialogProps = {
  action: ConfirmActionDialogAction | null;
  pending: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
  withinPortal?: boolean;
};

type DialogCopy = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  confirmTone: ButtonTone;
};

function dialogCopy(action: ConfirmActionDialogAction): DialogCopy {
  switch (action.kind) {
    case "new-session":
      return {
        title: "Start a fresh session?",
        description: "All Owners on this endpoint will switch to a fresh session.",
        confirmLabel: "Start fresh session",
        pendingLabel: "Starting fresh session…",
        confirmTone: "primary",
      };
    case "remove-pairing":
      return {
        title: `Delete pairing for ${action.label}?`,
        description: "This removes this device pairing, its endpoints, and local history from this browser.",
        confirmLabel: "Delete pairing",
        pendingLabel: "Deleting pairing…",
        confirmTone: "danger",
      };
    case "clear-local-data":
      return {
        title: "Clear this browser's Remote Pi identity, pairings, and history?",
        description: "This cannot be undone. It removes this browser's Remote Pi identity, pairings, and history.",
        confirmLabel: "Clear local data",
        pendingLabel: "Clearing local data…",
        confirmTone: "danger",
      };
  }
}

export function ConfirmActionDialog({ action, pending, error, onConfirm, onClose, onExitTransitionEnd, withinPortal = true }: ConfirmActionDialogProps) {
  const visibleAction = action ?? { kind: "new-session" };
  const copy = dialogCopy(visibleAction);
  const titleId = "pwa-confirm-action-title";
  const descriptionId = "pwa-confirm-action-description";

  return <Modal
    opened={action !== null}
    onClose={onClose}
    title={<div><span className="pwa-kicker">Confirm action</span><Text component="h2" id={titleId} className="pwa-confirm-title">{copy.title}</Text></div>}
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    centered
    size={460}
    withinPortal={withinPortal}
    portalProps={{ target: ".pwa-root" }}
    zIndex={310}
    trapFocus
    returnFocus
    onExitTransitionEnd={onExitTransitionEnd}
    closeOnClickOutside={!pending}
    closeOnEscape={!pending}
    closeButtonProps={{ disabled: pending, "aria-label": "Close confirmation dialog", title: "Close confirmation dialog" }}
    overlayProps={{ backgroundOpacity: 0.74, blur: 10 }}
    classNames={{ content: "pwa-confirm-dialog", header: "pwa-confirm-head", close: "pwa-icon-button" }}
    styles={{ header: { padding: 0 }, body: { padding: 0 } }}
  >
    <Stack gap={0}>
      <Text component="p" id={descriptionId} className="pwa-confirm-description">{copy.description}</Text>
      {error ? <Text component="p" className="pwa-confirm-error" role="alert">{error}</Text> : null}
      <Group className="pwa-confirm-actions" justify="flex-end" gap="xs">
        <Button tone="secondary" type="button" onClick={onClose} disabled={pending}>Cancel</Button>
        <Button tone={copy.confirmTone} type="button" onClick={onConfirm} disabled={pending}>{pending ? copy.pendingLabel : copy.confirmLabel}</Button>
      </Group>
    </Stack>
  </Modal>;
}
