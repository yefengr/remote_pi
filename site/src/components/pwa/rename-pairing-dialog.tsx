"use client";

import { useEffect, useRef, useState } from "react";
import { Group, Modal, Stack, Text } from "@mantine/core";
import { Button, Input } from "@/components/ui";
import type { PwaPeerRecord } from "@/lib/pwa/db";
import { displayPeer } from "@/components/pwa/workspace-view";

type RenamePairingDialogProps = {
  peer: PwaPeerRecord;
  onSave: (nickname: string) => Promise<void>;
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  focusFallbackSelectors?: readonly string[];
};

function suggestedName(peer: PwaPeerRecord): string {
  return peer.nickname || (peer.hostname ? `Pi on ${peer.hostname}` : "");
}

export function RenamePairingDialog({ peer, onSave, onClose, focusOrigin = null, focusFallbackSelectors = [] }: RenamePairingDialogProps) {
  const [value, setValue] = useState(() => suggestedName(peer));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const focusOriginRef = useRef<HTMLElement | null>(focusOrigin);
  const focusOriginCapturedRef = useRef(focusOrigin !== null);
  const focusFallbackSelectorsRef = useRef(focusFallbackSelectors);

  useEffect(() => {
    mountedRef.current = true;
    if (!focusOriginCapturedRef.current) {
      focusOriginCapturedRef.current = true;
      const activeElement = document.activeElement;
      focusOriginRef.current = activeElement instanceof HTMLElement && activeElement !== document.body && activeElement !== document.documentElement
        ? activeElement
        : null;
    }
    const input = document.getElementById("pwa-rename-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const restoreFocusAndClose = () => {
    if (savingRef.current) return;
    const candidates = [
      focusOriginRef.current,
      ...focusFallbackSelectorsRef.current.map((selector) => document.querySelector<HTMLElement>(selector)),
    ];
    const focusTarget = candidates.find((candidate): candidate is HTMLElement => (
      candidate !== null
      && candidate.isConnected
      && !candidate.matches(":disabled")
      && candidate.getClientRects().length > 0
      && !candidate.closest('[aria-hidden="true"]')
    ));
    focusTarget?.focus({ preventScroll: true });
    onClose();
  };

  const nickname = value.trim();
  const submit = async () => {
    if (!nickname || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    let saved = false;
    try {
      await onSave(nickname);
      saved = true;
    } catch {
      if (mountedRef.current) setSaveError("Could not save this pairing name. Try again.");
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
    if (saved && mountedRef.current) restoreFocusAndClose();
  };

  return <Modal
    opened
    onClose={restoreFocusAndClose}
    title={<div><span className="pwa-kicker">Pairing record</span><Text component="h2" id="pwa-rename-title">Rename pairing</Text></div>}
    aria-labelledby="pwa-rename-title"
    aria-describedby="pwa-rename-description"
    centered
    size={420}
    withinPortal={false}
    trapFocus
    returnFocus
    closeOnClickOutside={!saving}
    closeOnEscape={!saving}
    closeButtonProps={{ disabled: saving, "aria-label": "Close rename dialog", title: "Close" }}
    overlayProps={{ backgroundOpacity: 0.74, blur: 10 }}
    classNames={{ content: "pwa-rename-dialog", header: "pwa-rename-head", close: "pwa-icon-button" }}
    styles={{ header: { padding: 0 }, body: { padding: 0 } }}
  >
    <Stack gap={0}>
      <Text component="p" id="pwa-rename-description" className="pwa-rename-description">Choose a local name for <Text component="strong">{displayPeer(peer)}</Text>. This only changes the label in this browser.</Text>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input
          className="pwa-rename-field"
          id="pwa-rename-input"
          label="Pairing name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          data-autofocus
          disabled={saving}
        />
        {saveError ? <Text component="p" className="pwa-error" role="alert">{saveError}</Text> : null}
        <Group className="pwa-rename-actions" justify="flex-end" gap="xs">
          <Button tone="secondary" type="button" onClick={restoreFocusAndClose} disabled={saving}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={!nickname || saving}>{saving ? "Saving…" : "Save"}</Button>
        </Group>
      </form>
    </Stack>
  </Modal>;
}
