import { signChallenge, publicKeyToRelayId } from "./crypto";
import { decodeChallenge, decodeRelayFrame, encodeControlFrame, parseJson } from "./protocol";
import { decodeUtf8, toWebSocketUrl, truncateUtf8 } from "./encoding";
import type { ControlFrame, ControlOutbound, OwnerKeyPair, RelayClientState, RouteFrame } from "./types";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export interface RelayClientOptions { relayUrl: string; identity: OwnerKeyPair; webSocketFactory?: WebSocketFactory }
export interface RelayClientEventMap {
  state: (state: RelayClientState) => void;
  authenticated: () => void;
  route: (route: RouteFrame) => void;
  control: (frame: ControlFrame) => void;
  error: (error: Error) => void;
  close: (event: CloseEvent) => void;
}
type EventName = keyof RelayClientEventMap;
type EventCallback<K extends EventName> = RelayClientEventMap[K];
const OPEN = 1;
const APPLICATION_ERROR_CLOSE_CODE = 4002;

/** Browser-native authenticated Owner connection for endpoint discovery/routes. */
export class RelayClient {
  private socket: WebSocketLike | null = null;
  private authenticated = false;
  private connectPromise: Promise<void> | null = null;
  private connectReject: ((reason?: unknown) => void) | null = null;
  private currentState: RelayClientState = "idle";
  private readonly listeners: { [K in EventName]: Set<EventCallback<K>> } = {
    state: new Set(), authenticated: new Set(), route: new Set(), control: new Set(), error: new Set(), close: new Set(),
  } as { [K in EventName]: Set<EventCallback<K>> };

  constructor(private readonly options: RelayClientOptions) {}
  get state(): RelayClientState { return this.currentState; }
  get ownerId(): string { return publicKeyToRelayId(this.options.identity.publicKey); }
  on<K extends EventName>(event: K, callback: EventCallback<K>): () => void {
    this.listeners[event].add(callback);
    return () => this.listeners[event].delete(callback);
  }
  async connect(): Promise<void> {
    if (this.currentState === "open") return;
    if (this.connectPromise) return this.connectPromise;
    this.setState("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectReject = reject;
      const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
      let socket: WebSocketLike;
      try { socket = factory(toWebSocketUrl(this.options.relayUrl)); } catch (error) { this.clearConnectionState(); this.setState("closed"); reject(error); return; }
      this.socket = socket;
      this.authenticated = false;
      socket.onopen = () => {
        this.setState("authenticating");
        try { socket.send(JSON.stringify({ type: "hello", protocol_version: 2, role: "owner", pubkey: this.ownerId })); } catch (error) { this.failConnection(error, reject); }
      };
      socket.onmessage = (event) => { void this.handleMessage(event.data, resolve, reject); };
      socket.onerror = () => {
        const error = new Error("Relay WebSocket error");
        this.emit("error", error);
        if (!this.authenticated) this.failConnection(error, reject);
      };
      socket.onclose = (event) => {
        const wasAuthenticated = this.authenticated;
        const pendingReject = this.connectReject;
        this.clearConnectionState();
        this.setState("closed");
        this.emit("close", event);
        if (!wasAuthenticated) pendingReject?.(new Error("Relay closed during authentication"));
      };
    });
    try { await this.connectPromise; } finally { this.connectPromise = null; this.connectReject = null; }
  }
  sendRoute(route: RouteFrame): boolean {
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated) return false;
    if (route.target_owner_id !== undefined || route.source_owner_id !== undefined) return false;
    try { this.socket.send(JSON.stringify(route)); return true; } catch (error) { this.emit("error", error instanceof Error ? error : new Error(String(error))); return false; }
  }
  subscribeEndpoints(deviceIds: string[]): boolean {
    return this.sendControl({ type: "subscribe_endpoints", device_ids: [...new Set(deviceIds)] });
  }
  sendControl(frame: ControlOutbound): boolean {
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated) return false;
    try { this.socket.send(encodeControlFrame(frame)); return true; } catch (error) { this.emit("error", error instanceof Error ? error : new Error(String(error))); return false; }
  }
  close(code = 1000, reason = "client closing"): void {
    const socket = this.socket;
    const reject = this.connectReject;
    this.clearConnectionState();
    this.setState(socket ? "closing" : "closed");
    reject?.(new Error("Relay connection closed by client"));
    if (!socket) return;
    try { socket.close(code === 1002 ? APPLICATION_ERROR_CLOSE_CODE : code, truncateUtf8(reason, 123)); } catch (error) { this.emit("error", error instanceof Error ? error : new Error(String(error))); } finally { this.setState("closed"); }
  }
  private async handleMessage(raw: unknown, resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    const text = await toText(raw);
    if (text === undefined) return;
    if (!this.authenticated) {
      const challenge = decodeChallenge(text);
      if (!challenge) return this.failConnection(new Error("Expected Relay challenge"), reject);
      try {
        this.socket?.send(JSON.stringify({ type: "auth", sig: await signChallenge(this.options.identity.privateKey, challenge.nonce) }));
        this.authenticated = true;
        this.setState("open");
        this.emit("authenticated");
        resolve();
      } catch (error) { this.failConnection(error, reject); }
      return;
    }
    const frame = decodeRelayFrame(parseJson(text));
    if (frame?.kind === "route") this.emit("route", frame.route);
    else if (frame?.kind === "control") this.emit("control", frame.frame);
  }
  private failConnection(error: unknown, reject: (reason?: unknown) => void): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const socket = this.socket;
    this.clearConnectionState(); this.setState("closed"); this.emit("error", normalized); reject(normalized);
    try { socket?.close(APPLICATION_ERROR_CLOSE_CODE, truncateUtf8(normalized.message, 123)); } catch (closeError) { this.emit("error", closeError instanceof Error ? closeError : new Error(String(closeError))); }
  }
  private clearConnectionState(): void { this.authenticated = false; this.socket = null; this.connectPromise = null; this.connectReject = null; }
  private setState(state: RelayClientState): void { if (this.currentState !== state) { this.currentState = state; this.emit("state", state); } }
  private emit<K extends EventName>(event: K, ...args: Parameters<RelayClientEventMap[K]>): void { for (const callback of this.listeners[event]) (callback as (...values: Parameters<RelayClientEventMap[K]>) => void)(...args); }
}
async function toText(raw: unknown): Promise<string | undefined> {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(raw));
  if (raw instanceof Uint8Array) return decodeUtf8(raw);
  if (typeof Blob !== "undefined" && raw instanceof Blob) return decodeUtf8(new Uint8Array(await raw.arrayBuffer()));
  return undefined;
}
