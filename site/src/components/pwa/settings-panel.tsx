"use client";

import { useEffect, useState } from "react";
import { Check, Trash2, X } from "lucide-react";

type SettingsPanelProps = {
  relayUrl: string;
  defaultRelayUrl: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
  onClearData: () => Promise<void>;
};

export function SettingsPanel({ relayUrl, defaultRelayUrl, onSave, onClose, onClearData }: SettingsPanelProps) {
  const [value, setValue] = useState(relayUrl);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside className="pwa-settings" role="dialog" aria-modal="true" aria-labelledby="pwa-settings-title">
      <div className="pwa-settings-head">
        <div><span className="pwa-kicker">Preferences</span><h2 id="pwa-settings-title">Settings</h2></div>
        <button className="pwa-icon-button" type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
      </div>
      <label className="pwa-field">
        <span>Relay URL</span>
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={defaultRelayUrl} spellCheck={false} />
        <small>Use https:// for a secure relay. WebSocket is selected automatically.</small>
      </label>
      <div className="pwa-settings-note"><Check size={15} /><span>Owner identity and session history live in this browser only.</span></div>
      <button className="pwa-primary-button" type="button" onClick={() => void onSave(value)}>Save settings</button>
      <button className="pwa-danger-button" type="button" onClick={() => void onClearData()}><Trash2 size={15} /> Clear local data</button>
    </aside>
  );
}
