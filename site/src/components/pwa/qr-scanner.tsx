"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { ImageUp, X } from "lucide-react";

function stopControls(controls: IScannerControls | null, stoppedControls: WeakSet<IScannerControls>) {
  if (!controls || stoppedControls.has(controls)) return;
  stoppedControls.add(controls);
  controls.stop();
}

export function QrScanner({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const stoppedControlsRef = useRef<WeakSet<IScannerControls>>(new WeakSet());
  const scannerStateRef = useRef({ active: false, claimed: false });
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const claimFirstResult = () => {
    const scannerState = scannerStateRef.current;
    if (!scannerState.active || scannerState.claimed) return false;
    scannerState.claimed = true;
    return true;
  };

  useEffect(() => {
    const scannerState = { active: true, claimed: false };
    const stoppedControls = stoppedControlsRef.current;
    scannerStateRef.current = scannerState;
    const reader = new BrowserQRCodeReader();
    const handleControls = (controls: IScannerControls) => {
      if (!scannerState.active || scannerState.claimed) {
        stopControls(controls, stoppedControls);
        return false;
      }
      controlsRef.current = controls;
      return true;
    };

    void reader
      .decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        videoRef.current ?? undefined,
        (result, decodeError, controls) => {
          if (!handleControls(controls)) return;
          if (result) {
            if (!claimFirstResult()) return;
            stopControls(controlsRef.current, stoppedControls);
            onScanRef.current(result.getText());
            return;
          }
          if (decodeError && decodeError.name !== "NotFoundException" && scannerState.active && !scannerState.claimed) {
            setError("Could not read this QR code.");
          }
        },
      )
      .then((controls) => {
        handleControls(controls);
      })
      .catch(() => {
        if (scannerState.active && !scannerState.claimed) {
          setError("Camera access was unavailable. Use an image instead.");
        }
      });

    return () => {
      scannerState.active = false;
      stopControls(controlsRef.current, stoppedControls);
      controlsRef.current = null;
    };
  }, []);

  const scanImage = async (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    let result;
    try {
      result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
    } catch {
      const scannerState = scannerStateRef.current;
      if (scannerState.active && !scannerState.claimed) {
        setError("No Remote Pi QR code was found in that image.");
      }
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!claimFirstResult()) return;
    stopControls(controlsRef.current, stoppedControlsRef.current);
    onScanRef.current(result.getText());
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
