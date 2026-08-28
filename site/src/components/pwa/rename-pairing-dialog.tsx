"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

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

  return <div className="pwa-rename-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="pwa-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-rename-title" aria-describedby="pwa-rename-description">
      <div className="pwa-rename-head">
        <div>
          <span className="pwa-kicker">Pairing record</span>
          <h2 id="pwa-rename-title">Rename pairing</h2>
        </div>
        <button className="pwa-icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close rename dialog" title="Close"><X size={18} /></button>
      </div>
      <p id="pwa-rename-description" className="pwa-rename-description">Choose a local name for <strong>{displayPeer(peer)}</strong>. This only changes the label in this browser.</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="pwa-rename-field" htmlFor="pwa-rename-input">Pairing name
          <input ref={inputRef} id="pwa-rename-input" value={value} onChange={(event) => setValue(event.target.value)} maxLength={80} autoCapitalize="words" autoCorrect="off" spellCheck={false} disabled={saving} />
        </label>
        {saveError ? <p className="pwa-error" role="alert">{saveError}</p> : null}
        <div className="pwa-rename-actions">
          <button className="pwa-secondary-button" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="pwa-primary-button" type="submit" disabled={!nickname || saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  </div>;
}
