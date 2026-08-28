"use client";

import { useState } from "react";
import { Button, Textarea } from "@mantine/core";
import { Link2, RefreshCw, WifiOff } from "lucide-react";
import { QrScanner } from "@/components/pwa/qr-scanner";

export type StartupError = {
  title: string;
  message: string;
  action?: string;
};

export function describeStartupFailure(failure: unknown): StartupError {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (message === "secure_context_required" || (typeof window !== "undefined" && !window.isSecureContext)) return { title: "Secure connection required", message: "Safari blocks the browser cryptography and camera APIs on a plain LAN HTTP address. Open this app over HTTPS, or use localhost on the same device.", action: "Use an HTTPS address" };
  if (message === "web_crypto_unavailable" || typeof globalThis.crypto?.getRandomValues !== "function") return { title: "Browser cryptography unavailable", message: "This browser does not expose a secure random source. Open the PWA in a current Safari, Chrome, or Firefox session over HTTPS." };
  if (message === "indexeddb_unavailable" || typeof indexedDB === "undefined") return { title: "Local storage unavailable", message: "IndexedDB is disabled in this browser mode. Allow site data for Remote Pi and reload the page." };
  const databaseCode = typeof failure === "object" && failure !== null && "code" in failure ? failure.code : undefined;
  if (databaseCode === "blocked") return { title: "Local workspace is busy", message: "Another Remote Pi tab is using an older local workspace. Close that tab and reload this app." };
  if (databaseCode === "versionchange") return { title: "Local workspace changed", message: "Another Remote Pi tab changed the local workspace schema. Reload this app to reopen it." };
  if (databaseCode === "migration_failed") return { title: "Local workspace migration failed", message: "Remote Pi could not upgrade the saved browser workspace. Reload the app and try again." };
  if (databaseCode === "open_failed") return { title: "Could not open local workspace", message: "Remote Pi could not open the saved browser workspace. Allow site data and reload the app." };
  if (message === "startup_timeout") return { title: "Local workspace timed out", message: "The browser did not finish opening local storage. Close other Remote Pi tabs, allow site data, and try again." };
  return { title: "Could not open local workspace", message: message || "The browser could not initialize the local PWA database.", action: "Reload the app" };
}

export function StartupLoading() {
  return <div className="pwa-loading"><div><span className="pwa-loading-mark">π</span><p>Opening local workspace<span>...</span></p></div></div>;
}

export function StartupErrorView({ error, onRetry }: { error: StartupError | null; onRetry: () => void }) {
  return <main className="pwa-startup-error"><div className="pwa-startup-card"><span className="pwa-startup-icon"><WifiOff size={22} /></span><span className="pwa-kicker">Remote Pi / browser workspace</span><h1>{error?.title || "PWA unavailable"}</h1><p>{error?.message || "The browser could not start the local workspace."}</p>{error?.action ? <p className="pwa-startup-action-note">{error.action}</p> : null}<div className="pwa-startup-actions"><Button className="pwa-primary-button" type="button" onClick={onRetry} leftSection={<RefreshCw size={16} />}>Reload</Button></div></div></main>;
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
  return <div className="pwa-pairing-dialog"><QrScanner onScan={onScan} onClose={onClose} /><div className="pwa-manual-pairing"><div className="pwa-divider"><span>or use the pairing code</span></div><Textarea aria-label="Pairing code" classNames={{ input: "pwa-manual-pairing-input" }} value={manualValue} onChange={(event) => setManualValue(event.target.value)} placeholder="remotepi://pair?..." rows={3} resize="vertical" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><Button className="pwa-secondary-button" variant="default" type="button" onClick={submitManual} disabled={!manualValue.trim()} leftSection={<Link2 size={15} />} fullWidth>Use pasted code</Button>{manualError ? <p className="pwa-error">{manualError}</p> : null}</div></div>;
}
