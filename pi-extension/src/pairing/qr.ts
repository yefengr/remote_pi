import { randomBytes } from "node:crypto";
import qrTerminal from "qrcode-terminal";

export const TOKEN_TTL_MS = 60_000;
export const PAIR_TTL_MIN_MS = 10_000;
export const PAIR_TTL_MAX_MS = 600_000;

export function clampPairTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return TOKEN_TTL_MS;
  return Math.min(PAIR_TTL_MAX_MS, Math.max(PAIR_TTL_MIN_MS, Math.floor(ttlMs)));
}

interface ActiveToken {
  token: string;
  expiresAt: number;
  consumed: boolean;
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

  consumeToken(token: string): "ok" | "expired" | "consumed" | "unknown" {
    if (!this.active || this.active.token !== token) return "unknown";
    if (this.active.consumed) return "consumed";
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
): string {
  const params = new URLSearchParams({
    t: token,
    epk: Buffer.from(longtermEdPk).toString("base64url"),
    n: sessionName.slice(0, 80),
    ep: endpointId,
    rt: runtimeInstanceId,
  });
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
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const rotate = () => {
    if (stopped) return;
    const { token, expiresAt } = qrSession.issueToken();
    displayQR(buildQRUri(token, longtermEdPk, sessionName, endpointId, runtimeInstanceId));
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
