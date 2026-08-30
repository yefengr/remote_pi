import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { ed25519Sign } from "../pairing/crypto.js";
import type { Ed25519Keypair } from "../pairing/crypto.js";

const AUTH_TIMEOUT_MS = 5_000;
const LIVENESS_TIMEOUT_MS = 70_000;
const LIVENESS_CHECK_MS = 20_000;

export type EndpointMetadata = {
  kind: "daemon" | "interactive";
  name?: string;
  cwd?: string;
  pid?: number;
  started_at?: number;
  model?: string;
  thinking?: string;
  working?: boolean;
};

export type HostConnectOptions = {
  role: "host";
  endpointId: string;
  runtimeInstanceId: string;
  metadata: EndpointMetadata;
  authorizedOwnerIds: readonly string[];
};

export type OwnerConnectOptions = { role: "owner" };
export type ConnectOptions = HostConnectOptions | OwnerConnectOptions;

interface ChallengeMsg { type: "challenge"; nonce: string }
interface AuthMsg { type: "auth"; sig: string }

export interface RelayClientEvents {
  message: [line: string];
  close: [];
  error: [err: Error];
}

/** Authenticated WebSocket client for the endpoint relay. */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private lastActivityAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly keypair: Ed25519Keypair,
  ) {
    super();
  }

  async connect(options: ConnectOptions = { role: "owner" }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("error", (err) => reject(err));
      ws.on("open", async () => {
        try {
          await this.authenticate(ws, options);
          this.lastActivityAt = Date.now();
          ws.on("message", (raw) => {
            this.lastActivityAt = Date.now();
            const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (trimmed) this.emit("message", trimmed);
            }
          });
          ws.on("ping", () => { this.lastActivityAt = Date.now(); });
          ws.on("pong", () => { this.lastActivityAt = Date.now(); });
          ws.on("close", () => {
            this.stopLiveness();
            this.emit("close");
          });
          this.startLiveness(ws);
          resolve();
        } catch (err) {
          ws.terminate();
          reject(err);
        }
      });
    });
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(line: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay: not connected");
    }
    this.ws.send(line);
  }

  sendControl(frame: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.stopLiveness();
    this.ws?.close();
    this.ws = null;
  }

  private startLiveness(ws: WebSocket): void {
    this.stopLiveness();
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt > LIVENESS_TIMEOUT_MS) {
        this.stopLiveness();
        ws.terminate();
      }
    }, LIVENESS_CHECK_MS);
  }

  private stopLiveness(): void {
    if (!this.livenessTimer) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private async authenticate(ws: WebSocket, options: ConnectOptions): Promise<void> {
    const pubkey = Buffer.from(this.keypair.publicKey).toString("base64");
    const hello = options.role === "host"
      ? {
          type: "hello",
          protocol_version: 2,
          role: "host",
          pubkey,
          endpoint_id: options.endpointId,
          runtime_instance_id: options.runtimeInstanceId,
          metadata: options.metadata,
          authorized_owner_ids: options.authorizedOwnerIds,
        }
      : { type: "hello", protocol_version: 2, role: "owner", pubkey };
    this.rawSend(ws, JSON.stringify(hello));

    const challengeRaw = await this.nextMessage(ws);
    let challenge: ChallengeMsg | { type: "error"; code?: string; message?: string };
    try {
      challenge = JSON.parse(challengeRaw) as typeof challenge;
    } catch {
      throw new Error(`relay auth_failed: not JSON: ${challengeRaw}`);
    }
    if (challenge.type === "error") {
      const detail = challenge.code || challenge.message || "unknown";
      throw new Error(`relay rejected hello: ${detail}`);
    }
    if (challenge.type !== "challenge" || !challenge.nonce) {
      throw new Error(`relay auth_failed: expected challenge, got ${challengeRaw}`);
    }
    const nonce = Buffer.from(challenge.nonce, "base64");
    const auth: AuthMsg = {
      type: "auth",
      sig: Buffer.from(ed25519Sign(this.keypair.secretKey, nonce)).toString("base64"),
    };
    this.rawSend(ws, JSON.stringify(auth));
  }

  private nextMessage(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay auth timeout")), AUTH_TIMEOUT_MS);
      ws.once("message", (raw) => {
        clearTimeout(timer);
        resolve(Buffer.isBuffer(raw) ? raw.toString() : String(raw));
      });
    });
  }

  private rawSend(ws: WebSocket, data: string): void {
    ws.send(data);
  }
}
