"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { browserName } from "@/lib/pwa/runtime";
import { createPairRequest, normalizePairDeviceId, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { makePwaDeviceId, type PwaDeviceRecord } from "@/lib/pwa/db";
import type { OwnerKeyPair } from "@/lib/remote-pi/types";

const PAIRING_TIMEOUT_MS = 15_000;

type DevicePairingState = "idle" | "scanning" | "pairing";
type PairingAttempt = {
  relay: RelayClient;
  channel: PeerChannel | null;
  timer: ReturnType<typeof setTimeout> | null;
  reject: ((reason?: unknown) => void) | null;
  cancelled: boolean;
  cleanedUp: boolean;
};
export type DevicePairingResult = {
  device: PwaDeviceRecord;
  endpointId: string;
};
export type UseDevicePairingOptions = {
  identity: OwnerKeyPair | null;
  relayUrl: string;
  onPaired: (result: DevicePairingResult) => Promise<void>;
  onError: (message: string | null) => void;
};
export type DevicePairingController = {
  state: DevicePairingState;
  open: () => void;
  close: () => void;
  pairFromQr: (raw: string) => Promise<void>;
};

export function useDevicePairing({ identity, relayUrl, onPaired, onError }: UseDevicePairingOptions): DevicePairingController {
  const [state, setState] = useState<DevicePairingState>("idle");
  const identityRef = useRef(identity);
  const relayUrlRef = useRef(relayUrl);
  const onPairedRef = useRef(onPaired);
  const onErrorRef = useRef(onError);
  const attemptRef = useRef<PairingAttempt | null>(null);
  useEffect(() => {
    identityRef.current = identity;
    relayUrlRef.current = relayUrl;
    onPairedRef.current = onPaired;
    onErrorRef.current = onError;
  }, [identity, onError, onPaired, relayUrl]);

  const cleanupAttempt = useCallback((attempt: PairingAttempt) => {
    if (attempt.cleanedUp) return;
    attempt.cleanedUp = true;
    if (attempt.timer !== null) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
    attempt.channel?.close();
    attempt.relay.close();
    if (attemptRef.current === attempt) attemptRef.current = null;
  }, []);
  useEffect(() => () => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.reject?.(new Error("Pairing cancelled because the PWA was unmounted."));
    cleanupAttempt(attempt);
  }, [cleanupAttempt]);

  const open = useCallback(() => { setState("scanning"); }, []);
  const close = useCallback(() => {
    setState((current) => current === "scanning" ? "idle" : current);
  }, []);
  const pairFromQr = useCallback(async (raw: string) => {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) return;
    const configuredRelayUrl = relayUrlRef.current;
    const payload = parsePairUri(raw);
    if (!payload || relayMismatch(payload.relayUrl, configuredRelayUrl)) {
      onErrorRef.current(payload ? "This QR belongs to a different Relay." : "That is not a valid endpoint pairing QR.");
      return;
    }
    setState("pairing");
    onErrorRef.current(null);
    const deviceId = normalizePairDeviceId(payload.deviceId);
    const relay = new RelayClient({ relayUrl: payload.relayUrl || configuredRelayUrl, identity: currentIdentity });
    const attempt: PairingAttempt = { relay, channel: null, timer: null, reject: null, cancelled: false, cleanedUp: false };
    attemptRef.current = attempt;
    const isActive = () => attemptRef.current === attempt && !attempt.cancelled;
    try {
      const paired = await new Promise<PwaDeviceRecord>((resolve, reject) => {
        attempt.reject = reject;
        attempt.timer = setTimeout(() => reject(new Error("Pairing timed out. Generate a fresh QR on the Pi.")), PAIRING_TIMEOUT_MS);
        attempt.channel = new PeerChannel({
          relay,
          endpoint: { deviceId, endpointId: payload.endpointId, runtimeInstanceId: payload.runtimeInstanceId },
          onPairOk: (ok) => {
            if (!isActive()) return;
            if (ok.endpoint_id !== payload.endpointId) { if (attempt.timer !== null) clearTimeout(attempt.timer); attempt.timer = null; reject(new Error("Pairing response belongs to a different endpoint.")); return; }
            if (attempt.timer !== null) clearTimeout(attempt.timer);
            attempt.timer = null;
            resolve({ id: makePwaDeviceId(deviceId), deviceId, relayUrl: payload.relayUrl || configuredRelayUrl, pairedAt: new Date().toISOString(), hostname: ok.hostname, harness: ok.harness });
          },
          onPairError: (pairError) => { if (!isActive()) return; if (attempt.timer !== null) clearTimeout(attempt.timer); attempt.timer = null; reject(new Error(pairError.message)); },
          onMalformed: (reason) => { if (!isActive()) return; if (attempt.timer !== null) clearTimeout(attempt.timer); attempt.timer = null; reject(new Error(reason)); },
        });
        void relay.connect().then(() => {
          if (!isActive()) return;
          if (!attempt.channel?.sendPairRequest(createPairRequest(payload.token, browserName(), globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`))) throw new Error("Relay is not ready for pairing.");
        }).catch(reject);
      });
      await onPairedRef.current({ device: paired, endpointId: payload.endpointId });
      if (isActive()) setState("idle");
    } catch (pairingError) {
      if (isActive()) {
        onErrorRef.current(pairingError instanceof Error ? pairingError.message : "Pairing failed.");
        setState("scanning");
      }
    } finally {
      cleanupAttempt(attempt);
    }
  }, [cleanupAttempt]);

  return { state, open, close, pairFromQr };
}
