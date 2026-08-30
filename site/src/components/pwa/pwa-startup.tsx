"use client";

import { useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { Link2, RefreshCw, WifiOff } from "lucide-react";
import { QrScanner } from "@/components/pwa/qr-scanner";
import type { StartupError } from "@/components/pwa/startup-error";

export { describeStartupFailure, type StartupError } from "@/components/pwa/startup-error";

export function StartupLoading() {
  return <div className="pwa-loading"><div><span className="pwa-loading-mark">π</span><p>Opening local workspace<span>...</span></p></div></div>;
}

export function StartupErrorView({ error, onRetry }: { error: StartupError | null; onRetry: () => void }) {
  return <main className="pwa-startup-error"><div className="pwa-startup-card"><span className="pwa-startup-icon"><WifiOff size={22} /></span><span className="pwa-kicker">Remote Pi / browser workspace</span><h1>{error?.title || "PWA unavailable"}</h1><p>{error?.message || "The browser could not start the local workspace."}</p>{error?.action ? <p className="pwa-startup-action-note">{error.action}</p> : null}<div className="pwa-startup-actions"><Button tone="primary" type="button" onClick={onRetry} leftSection={<RefreshCw size={16} />}>Reload</Button></div></div></main>;
}

export function PairingDialog({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const [manualValue, setManualValue] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const submitManual = () => {
    const value = manualValue.trim();
    if (!value.startsWith("remotepi://pair?")) {
      setManualError("Paste the full remotepi://pair?... code from Pi.");
      return;
    }
    setManualError(null);
    onScan(value);
  };
  return <div className="pwa-pairing-dialog"><QrScanner onScan={onScan} onClose={onClose} /><div className="pwa-manual-pairing"><div className="pwa-divider"><span>or use the pairing code</span></div><Textarea aria-label="Pairing code" classNames={{ input: "pwa-manual-pairing-input" }} value={manualValue} onChange={(event) => setManualValue(event.target.value)} placeholder="remotepi://pair?..." rows={3} resize="vertical" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><Button tone="secondary" type="button" onClick={submitManual} disabled={!manualValue.trim()} leftSection={<Link2 size={15} />} fullWidth>Use pasted code</Button>{manualError ? <p className="pwa-error">{manualError}</p> : null}</div></div>;
}
