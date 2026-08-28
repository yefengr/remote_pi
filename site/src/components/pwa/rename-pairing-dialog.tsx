"use client";

import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import type { PwaPeerRecord } from "@/lib/pwa/db";
import { displayPeer } from "@/components/pwa/workspace-view";

type RenamePairingDialogProps = {
  peer: PwaPeerRecord;
  onSave: (nickname: string) => Promise<void>;
  onClose: () => void;
};

function suggestedName(peer: PwaPeerRecord): string {
  return peer.nickname || (peer.hostname ? `Pi on ${peer.hostname}` : "");
}

export function RenamePairingDialog({ peer, onSave, onClose }: RenamePairingDialogProps) {
  const [value, setValue] = useState(() => suggestedName(peer));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    const input = document.getElementById("pwa-rename-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }, []);


  const nickname = value.trim();
  const submit = async () => {
    if (!nickname || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(nickname);
      onClose();
    } catch {
      setSaveError("Could not save this pairing name. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return <Modal
    opened
    onClose={onClose}
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
        <TextInput
          className="pwa-rename-field"
          id="pwa-rename-input"
          label="Pairing name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          disabled={saving}
        />
        {saveError ? <Text component="p" className="pwa-error" role="alert">{saveError}</Text> : null}
        <Group className="pwa-rename-actions" justify="flex-end" gap="xs">
          <Button className="pwa-secondary-button" type="button" variant="default" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="pwa-primary-button" type="submit" disabled={!nickname || saving}>{saving ? "Saving…" : "Save"}</Button>
        </Group>
      </form>
    </Stack>
  </Modal>;
}
