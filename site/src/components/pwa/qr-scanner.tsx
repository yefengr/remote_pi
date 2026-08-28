"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { BrowserQRCodeReader } from "@zxing/browser";
import { ImageUp, X } from "lucide-react";

export function QrScanner({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let active = true;
    void reader
      .decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        videoRef.current ?? undefined,
        (result, decodeError, controls) => {
          controlsRef.current = controls;
          if (!active || !result) {
            if (decodeError && decodeError.name !== "NotFoundException") setError("Could not read this QR code.");
            return;
          }
          active = false;
          controls.stop();
          onScan(result.getText());
        },
      )
      .catch(() => setError("Camera access was unavailable. Use an image instead."));

    return () => {
      active = false;
      controlsRef.current?.stop();
    };
  }, [onScan]);

  const scanImage = async (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      controlsRef.current?.stop();
      onScan(result.getText());
    } catch {
      setError("No Remote Pi QR code was found in that image.");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="pwa-scanner" role="dialog" aria-modal="true" aria-label="Scan pairing QR code">
      <div className="pwa-scanner-head">
        <div>
          <span className="pwa-kicker">Pair a Pi</span>
          <h2>Scan the pairing QR</h2>
        </div>
        <ActionIcon className="pwa-icon-button" type="button" variant="subtle" size={44} onClick={onClose} aria-label="Close scanner" title="Close scanner">
          <X size={18} />
        </ActionIcon>
      </div>
      <div className="pwa-scanner-frame">
        <video ref={videoRef} muted playsInline />
        <span className="pwa-scan-corner pwa-scan-corner-tl" />
        <span className="pwa-scan-corner pwa-scan-corner-tr" />
        <span className="pwa-scan-corner pwa-scan-corner-bl" />
        <span className="pwa-scan-corner pwa-scan-corner-br" />
      </div>
      <p className="pwa-muted">Hold the QR inside the frame. Camera access stays on this page.</p>
      <input ref={fileRef} className="pwa-file-input" type="file" accept="image/*" onChange={(event) => void scanImage(event.target.files?.[0])} />
      <Button className="pwa-secondary-button" type="button" variant="default" leftSection={<ImageUp size={16} />} onClick={() => fileRef.current?.click()}>Choose QR image</Button>
      {error ? <p className="pwa-error">{error}</p> : null}
    </div>
  );
}
