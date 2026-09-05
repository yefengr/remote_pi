import { randomBytes } from "node:crypto";
import qrTerminal from "qrcode-terminal";

export const TOKEN_TTL_MS = 60_000;
export const PAIR_TTL_MIN_MS = 10_000;
export const PAIR_TTL_MAX_MS = 600_000;

export function clampPairTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return TOKEN_TTL_MS;
  return Math.min(PAIR_TTL_MAX_MS, Math.max(PAIR_TTL_MIN_MS, Math.floor(ttlMs)));
}

export type TokenReservation = Readonly<{
  token: string;
  ownerId: string;
  requestId: string;
}>;

type ReservationState = {
  reservation: TokenReservation;
  status: "reserved" | "released" | "committed";
  completion?: unknown;
};

export type TokenReservationResult<T = unknown> =
  | { status: "reserved"; reservation: TokenReservation }
  | { status: "committed"; completion: T }
  | { status: "expired" | "consumed" | "unknown" };

interface ActiveToken {
  token: string;
  expiresAt: number;
  consumed: boolean;
  reservation?: ReservationState;
}

export class QRSession {
  private active: ActiveToken | null = null;

  generateToken(): string {
    return randomBytes(16).toString("base64url");
  }

  issueToken(ttlMs: number = TOKEN_TTL_MS): { token: string; expiresAt: number } {
    const token = this.generateToken();
    const expiresAt = Date.now() + ttlMs;
    this.active = { token, expiresAt, consumed: false };
    return { token, expiresAt };
  }

  reserveToken<T = unknown>(token: string, ownerId: string, requestId: string): TokenReservationResult<T> {
    const active = this.active;
    if (!active || active.token !== token) return { status: "unknown" };

    const existing = active.reservation;
    if (existing) {
      if (existing.reservation.ownerId !== ownerId || existing.reservation.requestId !== requestId) {
        return { status: "consumed" };
      }
      // A committed result belongs to the exact Owner/request and remains
      // replayable until this QR is replaced or cleared, even after its TTL.
      if (existing.status === "committed") {
        return { status: "committed", completion: existing.completion as T };
      }
    }
    if (Date.now() > active.expiresAt) return { status: "expired" };
    if (active.consumed) return { status: "consumed" };

    if (existing) {
      if (existing.status === "reserved") return { status: "reserved", reservation: existing.reservation };
      // A released reservation remains private to the original attempt. A
      // retry by that exact Owner/request may reacquire it; nobody else can.
    }

    const reservation = existing?.status === "released"
      ? Object.freeze({ token, ownerId, requestId })
      : existing?.reservation ?? Object.freeze({ token, ownerId, requestId });
    active.reservation = { reservation, status: "reserved" };
    return { status: "reserved", reservation };
  }

  commitToken<T>(reservation: TokenReservation, completion: T): boolean {
    const active = this.active;
    const state = active?.reservation;
    if (!active || !state || state.reservation !== reservation || state.status !== "reserved") return false;
    if (active.token !== reservation.token || Date.now() > active.expiresAt) return false;
    state.status = "committed";
    state.completion = completion;
    return true;
  }

  releaseToken(reservation: TokenReservation): boolean {
    const active = this.active;
    const state = active?.reservation;
    if (!active || !state || state.reservation !== reservation || state.status !== "reserved") return false;
    state.status = "released";
    return true;
  }

  isReservationCurrent(reservation: TokenReservation): boolean {
    const active = this.active;
    const state = active?.reservation;
    return !!active && !!state && state.reservation === reservation && state.status === "reserved" && active.token === reservation.token && Date.now() <= active.expiresAt;
  }

  /** Compatibility API for older callers; new pairing flows use reservations. */
  consumeToken(token: string): "ok" | "expired" | "consumed" | "unknown" {
    if (!this.active || this.active.token !== token) return "unknown";
    if (this.active.consumed || this.active.reservation) return "consumed";
    if (Date.now() > this.active.expiresAt) return "expired";
    this.active.consumed = true;
    return "ok";
  }

  clear(): void {
    this.active = null;
  }
}

export const qrSession = new QRSession();

/** Builds the endpoint-aware pairing URI. */
export function buildQRUri(
  token: string,
  longtermEdPk: Uint8Array,
  sessionName: string,
  endpointId: string,
  runtimeInstanceId: string,
  relayUrl?: string,
): string {
  const params = new URLSearchParams({
    t: token,
    epk: Buffer.from(longtermEdPk).toString("base64url"),
    n: sessionName.slice(0, 80),
    ep: endpointId,
    rt: runtimeInstanceId,
  });
  if (relayUrl) {
    try {
      const protocol = new URL(relayUrl).protocol;
      if (protocol === "http:" || protocol === "https:") params.set("r", relayUrl);
    } catch { /* invalid optional hint */ }
  }
  return `remotepi://pair?${params.toString()}`;
}

export function renderQRAscii(uri: string): string {
  let out = "";
  qrTerminal.generate(uri, { small: true }, (qrcode) => { out = qrcode; });
  return out;
}

export function displayQR(uri: string): void {
  process.stderr.write(`\nScan to pair:\n\n${renderQRAscii(uri)}\n`);
}

export function startQRRotation(
  longtermEdPk: Uint8Array,
  sessionName: string,
  endpointId: string,
  runtimeInstanceId: string,
  relayUrl: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const rotate = () => {
    if (stopped) return;
    const { token, expiresAt } = qrSession.issueToken();
    displayQR(buildQRUri(token, longtermEdPk, sessionName, endpointId, runtimeInstanceId, relayUrl));
    console.log(`Renews at ${new Date(expiresAt).toLocaleTimeString()} — waiting for scan…`);
    timer = setTimeout(rotate, TOKEN_TTL_MS);
  };
  rotate();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    qrSession.clear();
  };
}
