import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { ed25519Sign } from "../pairing/crypto.js";
import type { Ed25519Keypair } from "../pairing/crypto.js";

const CONNECT_TIMEOUT_MS = 10_000;
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

type PendingConnection = {
  ws: WebSocket;
  resolve: () => void;
  reject: (error: Error) => void;
  onEarlyClose: () => void;
  onOpen: () => void;
  connectTimer: ReturnType<typeof setTimeout> | null;
};

type PendingMessage = {
  ws: WebSocket;
  cancel: (error: Error) => void;
};

/** Authenticated WebSocket client for the endpoint relay. */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private lastActivityAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private livenessSocket: WebSocket | null = null;
  private pendingConnection: PendingConnection | null = null;
  private pendingMessage: PendingMessage | null = null;

  constructor(
    private readonly url: string,
    private readonly keypair: Ed25519Keypair,
  ) {
    super();
  }

  connect(options: ConnectOptions = { role: "owner" }): Promise<void> {
    this.close();
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const onEarlyClose = () => this.abortPendingConnection(ws, new Error("relay connection closed"), false);
      const onOpen = () => {
        this.clearConnectTimer(ws);
        void this.finishConnection(ws, options);
      };
      this.ws = ws;
      const pending: PendingConnection = { ws, resolve, reject, onEarlyClose, onOpen, connectTimer: null };
      this.pendingConnection = pending;
      pending.connectTimer = setTimeout(
        () => this.abortPendingConnection(ws, new Error("relay connection timeout"), true),
        CONNECT_TIMEOUT_MS,
      );
      ws.on("error", (error) => {
        if (this.ws !== ws) return;
        this.reportError(error);
        if (this.isPendingConnection(ws)) this.abortPendingConnection(ws, error, true);
      });
      ws.once("close", onEarlyClose);
      ws.once("open", onOpen);
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

  sendControl(frame: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.reportError(this.asError(error));
      return false;
    }
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    this.stopLiveness(ws);
    if (this.isPendingConnection(ws)) {
      this.abortPendingConnection(ws, new Error("relay connection closed"), true);
      return;
    }
    this.ws = null;
    ws.close();
  }

  private async finishConnection(ws: WebSocket, options: ConnectOptions): Promise<void> {
    if (!this.isPendingConnection(ws)) return;
    try {
      await this.authenticate(ws, options);
      if (!this.isPendingConnection(ws)) return;
      this.lastActivityAt = Date.now();
      const pending = this.pendingConnection;
      if (!pending || pending.ws !== ws) return;
      ws.removeListener("close", pending.onEarlyClose);
      ws.on("message", (raw) => {
        if (this.ws !== ws) return;
        this.lastActivityAt = Date.now();
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) this.emit("message", trimmed);
        }
      });
      ws.on("ping", () => { if (this.ws === ws) this.lastActivityAt = Date.now(); });
      ws.on("pong", () => { if (this.ws === ws) this.lastActivityAt = Date.now(); });
      ws.on("close", () => {
        if (this.ws !== ws) return;
        this.stopLiveness(ws);
        this.ws = null;
        this.emit("close");
      });
      this.startLiveness(ws);
      this.resolvePendingConnection(ws);
    } catch (error) {
      this.abortPendingConnection(ws, this.asError(error), true);
    }
  }

  private startLiveness(ws: WebSocket): void {
    this.stopLiveness();
    this.livenessSocket = ws;
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt > LIVENESS_TIMEOUT_MS) {
        this.stopLiveness(ws);
        ws.terminate();
      }
    }, LIVENESS_CHECK_MS);
  }

  private stopLiveness(ws?: WebSocket): void {
    if (!this.livenessTimer || (ws && this.livenessSocket !== ws)) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.livenessSocket = null;
  }

  private async authenticate(ws: WebSocket, options: ConnectOptions): Promise<void> {
    this.assertPendingConnection(ws);
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
    this.assertPendingConnection(ws);
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
    this.assertPendingConnection(ws);
    this.rawSend(ws, JSON.stringify(auth));
  }

  private nextMessage(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        ws.removeListener("message", onMessage);
        ws.removeListener("error", onError);
        ws.removeListener("close", onClose);
        if (this.pendingMessage?.ws === ws) this.pendingMessage = null;
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };
      const onMessage = (raw: unknown) => finish(() => resolve(Buffer.isBuffer(raw) ? raw.toString() : String(raw)));
      const onError = (error: Error) => finish(() => reject(error));
      const onClose = () => finish(() => reject(new Error("relay connection closed")));
      timer = setTimeout(() => finish(() => reject(new Error("relay auth timeout"))), AUTH_TIMEOUT_MS);
      ws.once("message", onMessage);
      ws.once("error", onError);
      ws.once("close", onClose);
      this.pendingMessage = { ws, cancel: (error) => finish(() => reject(error)) };
    });
  }

  private isPendingConnection(ws: WebSocket): boolean {
    return this.ws === ws && this.pendingConnection?.ws === ws;
  }

  private assertPendingConnection(ws: WebSocket): void {
    if (!this.isPendingConnection(ws)) throw new Error("relay connection closed");
  }

  private resolvePendingConnection(ws: WebSocket): void {
    const pending = this.pendingConnection;
    if (!pending || pending.ws !== ws) return;
    this.pendingConnection = null;
    this.clearPendingConnectionListeners(pending);
    pending.resolve();
  }

  private abortPendingConnection(ws: WebSocket, error: Error, terminate: boolean): void {
    const pending = this.pendingConnection;
    if (!pending || pending.ws !== ws) return;
    this.pendingConnection = null;
    this.clearPendingConnectionListeners(pending);
    this.cancelPendingMessage(ws, error);
    this.stopLiveness(ws);
    if (this.ws === ws) this.ws = null;
    pending.reject(error);
    if (terminate) ws.terminate();
  }

  private clearConnectTimer(ws: WebSocket): void {
    const pending = this.pendingConnection;
    if (!pending || pending.ws !== ws || !pending.connectTimer) return;
    clearTimeout(pending.connectTimer);
    pending.connectTimer = null;
  }

  private clearPendingConnectionListeners(pending: PendingConnection): void {
    if (pending.connectTimer) clearTimeout(pending.connectTimer);
    pending.connectTimer = null;
    pending.ws.removeListener("close", pending.onEarlyClose);
    pending.ws.removeListener("open", pending.onOpen);
  }

  private cancelPendingMessage(ws: WebSocket, error: Error): void {
    const pending = this.pendingMessage;
    if (!pending || pending.ws !== ws) return;
    this.pendingMessage = null;
    pending.cancel(error);
  }

  private reportError(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private rawSend(ws: WebSocket, data: string): void {
    ws.send(data);
  }
}
