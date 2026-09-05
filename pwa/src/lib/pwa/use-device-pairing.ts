"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { browserName } from "@/lib/pwa/runtime";
import { createPairRequest, normalizePairDeviceId, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { makePwaDeviceId, type PwaDeviceRecord } from "@/lib/pwa/db";
import type { OwnerKeyPair } from "@/lib/remote-pi/types";

const PAIRING_TIMEOUT_MS = 15_000;
const PAIRING_MAX_ATTEMPTS = 2;

type DevicePairingState = "idle" | "scanning" | "pairing";
type PairingAttempt = {
  relay: RelayClient | null;
  channel: PeerChannel | null;
  timer: ReturnType<typeof setTimeout> | null;
  reject: ((reason?: unknown) => void) | null;
  unsubscribeClose: (() => void) | null;
  requestId: string;
  cancelled: boolean;
  cleanedUp: boolean;
};
class RetryablePairingError extends Error {}
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

  const closeAttemptTransport = useCallback((attempt: PairingAttempt) => {
    if (attempt.timer !== null) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
    attempt.unsubscribeClose?.();
    attempt.unsubscribeClose = null;
    attempt.channel?.close();
    attempt.channel = null;
    attempt.relay?.close();
    attempt.relay = null;
    attempt.reject = null;
  }, []);
  const cleanupAttempt = useCallback((attempt: PairingAttempt) => {
    if (attempt.cleanedUp) return;
    attempt.cleanedUp = true;
    closeAttemptTransport(attempt);
    if (attemptRef.current === attempt) attemptRef.current = null;
  }, [closeAttemptTransport]);
  const cancelAttempt = useCallback((attempt: PairingAttempt, message: string) => {
    attempt.cancelled = true;
    attempt.reject?.(new Error(message));
    cleanupAttempt(attempt);
  }, [cleanupAttempt]);
  useEffect(() => () => {
    const attempt = attemptRef.current;
    if (attempt) cancelAttempt(attempt, "Pairing cancelled because the PWA was unmounted.");
  }, [cancelAttempt]);

  const open = useCallback(() => { setState("scanning"); }, []);
  const close = useCallback(() => {
    const attempt = attemptRef.current;
    if (attempt) cancelAttempt(attempt, "Pairing cancelled by the user.");
    setState("idle");
  }, [cancelAttempt]);
  const pairFromQr = useCallback(async (raw: string) => {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) return;
    const configuredRelayUrl = relayUrlRef.current;
    const payload = parsePairUri(raw);
    if (!payload || relayMismatch(payload.relayUrl, configuredRelayUrl)) {
      onErrorRef.current(payload ? "This QR belongs to a different Relay." : "That is not a valid endpoint pairing QR.");
      return;
    }
    const previousAttempt = attemptRef.current;
    if (previousAttempt) cancelAttempt(previousAttempt, "Pairing cancelled by a newer pairing attempt.");
    setState("pairing");
    onErrorRef.current(null);
    const deviceId = normalizePairDeviceId(payload.deviceId);
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = createPairRequest(payload.token, browserName(), requestId);
    const attempt: PairingAttempt = { relay: null, channel: null, timer: null, reject: null, unsubscribeClose: null, requestId, cancelled: false, cleanedUp: false };
    attemptRef.current = attempt;
    const isActive = () => attemptRef.current === attempt && !attempt.cancelled;
    try {
      let paired: PwaDeviceRecord | null = null;
      for (let attemptNumber = 1; attemptNumber <= PAIRING_MAX_ATTEMPTS && !paired; attemptNumber += 1) {
        const relay = new RelayClient({ relayUrl: payload.relayUrl || configuredRelayUrl, identity: currentIdentity });
        attempt.relay = relay;
        try {
          paired = await new Promise<PwaDeviceRecord>((resolve, reject) => {
            let settled = false;
            let requestSent = false;
            const finish = (callback: () => void) => {
              if (settled) return;
              settled = true;
              if (attempt.timer !== null) { clearTimeout(attempt.timer); attempt.timer = null; }
              attempt.unsubscribeClose?.();
              attempt.unsubscribeClose = null;
              callback();
            };
            const fail = (reason: unknown, retryable: boolean) => {
              const error = reason instanceof Error ? reason : new Error(String(reason));
              finish(() => reject(retryable ? new RetryablePairingError(error.message) : error));
            };
            attempt.reject = (reason) => fail(reason ?? new Error("Pairing cancelled."), false);
            attempt.unsubscribeClose = relay.on("close", () => { if (isActive()) fail(new Error("Relay connection closed during pairing."), requestSent); });
            attempt.timer = setTimeout(() => fail(new Error("Pairing timed out. Generate a fresh QR on the Pi."), requestSent), PAIRING_TIMEOUT_MS);
            attempt.channel = new PeerChannel({
              relay,
              endpoint: { deviceId, endpointId: payload.endpointId, runtimeInstanceId: payload.runtimeInstanceId },
              onPairOk: (ok) => {
                if (!isActive()) return;
                if (ok.in_reply_to !== request.id) return;
                if (ok.endpoint_id !== payload.endpointId) { fail(new Error("Pairing response belongs to a different endpoint."), false); return; }
                finish(() => resolve({ id: makePwaDeviceId(deviceId), deviceId, relayUrl: payload.relayUrl || configuredRelayUrl, pairedAt: new Date().toISOString(), hostname: ok.hostname, harness: ok.harness }));
              },
              onPairError: (pairError) => { if (isActive() && pairError.in_reply_to === request.id) fail(new Error(pairError.message), false); },
              onMalformed: (reason) => { if (isActive()) fail(new Error(reason), false); },
            });
            void relay.connect().then(() => {
              if (!isActive()) return;
              requestSent = attempt.channel?.sendPairRequest(request) === true;
              if (!requestSent) fail(new Error("Relay is not ready for pairing."), false);
            }).catch((error) => fail(error, false));
          });
        } catch (pairingError) {
          closeAttemptTransport(attempt);
          if (!(pairingError instanceof RetryablePairingError) || attemptNumber === PAIRING_MAX_ATTEMPTS || !isActive()) throw pairingError;
        }
      }
      if (!paired || !isActive()) return;
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
  }, [cancelAttempt, cleanupAttempt, closeAttemptTransport]);

  return { state, open, close, pairFromQr };
}
