import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RelayResolution } from "../config.js";
import type { Ed25519Keypair } from "../pairing/crypto.js";
import type { HostConnectOptions, RelayClient } from "../transport/relay_client.js";

export type RemoteState = "idle" | "started";
export type RelayConnectivity = "connected" | "reconnecting" | "disconnected";
export type InitialRelayResult = "completed" | "cancelled";
export type RelayStartContext = Pick<ExtensionContext, "ui" | "cwd">;

export interface RelayLifecycleDependencies {
  loadIdentity(): Promise<Ed25519Keypair>;
  resolveRelayUrl(): RelayResolution;
  createClient(relayUrl: string, identity: Ed25519Keypair): RelayClient;
  buildConnectOptions(cwd?: string): Promise<HostConnectOptions>;
  handleIdentityError(error: unknown, ctx: RelayStartContext): boolean;
  describeConnection(resolution: RelayResolution): string;
  onStateChange(): void;
  onConnected(client: RelayClient, ctx?: RelayStartContext): void;
  onDisconnected(): void;
}

const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class RelayLifecycle {
  private activeRelay: RelayClient | null = null;
  private pendingCandidate: RelayClient | null = null;
  private currentRelayUrl: string | null = null;
  private identity: Ed25519Keypair | null = null;
  private initialAttempt: Promise<InitialRelayResult> | null = null;
  private cancelInitialAttempt: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private isDisposed = false;
  private currentState: RemoteState = "idle";
  private readonly closedCandidates = new WeakSet<RelayClient>();

  constructor(private readonly deps: RelayLifecycleDependencies) {}

  get state(): RemoteState { return this.currentState; }
  get relay(): RelayClient | null { return this.activeRelay; }
  get relayUrl(): string | null { return this.currentRelayUrl; }
  get keypair(): Ed25519Keypair | null { return this.identity; }
  get disposed(): boolean { return this.isDisposed; }
  get hasPendingReconnect(): boolean { return this.reconnectTimer !== null; }
  get status(): RelayConnectivity {
    if (this.currentState === "idle") return "disconnected";
    return this.activeRelay?.isOpen() ? "connected" : "reconnecting";
  }

  isCurrent(candidate: RelayClient): boolean {
    return !this.isDisposed && this.currentState === "started" && this.activeRelay === candidate;
  }

  setDisposed(value: boolean): void {
    this.isDisposed = value;
  }

  start(ctx: RelayStartContext): Promise<InitialRelayResult> {
    const existing = this.initialAttempt;
    if (existing) return existing;
    if (this.currentState !== "idle") {
      const message = this.status === "reconnecting"
        ? "[remote-pi] Relay is reconnecting in background."
        : "[remote-pi] Already connected.";
      this.notify(ctx, message, "warning");
      return Promise.resolve("completed");
    }

    const operation = this.startInitial(ctx);
    let cancel!: () => void;
    const cancellation = new Promise<InitialRelayResult>((resolve) => {
      cancel = () => resolve("cancelled");
    });
    const attempt = Promise.race([operation.then(() => "completed" as const), cancellation]);
    this.initialAttempt = attempt;
    this.cancelInitialAttempt = cancel;
    void operation.catch(() => undefined);
    void attempt.then(
      () => this.clearInitialAttempt(attempt, cancel),
      () => this.clearInitialAttempt(attempt, cancel),
    );
    return attempt;
  }

  waitForInitial(): Promise<InitialRelayResult> {
    return this.initialAttempt ?? Promise.resolve("completed");
  }

  stop(): void {
    this.generation += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;

    const active = this.activeRelay;
    const pending = this.pendingCandidate;
    const cancel = this.cancelInitialAttempt;
    this.activeRelay = null;
    this.pendingCandidate = null;
    this.currentRelayUrl = null;
    this.initialAttempt = null;
    this.cancelInitialAttempt = null;
    this.currentState = "idle";

    cancel?.();
    if (active) this.closeCandidateOnce(active);
    if (pending && pending !== active) this.closeCandidateOnce(pending);
    this.deps.onDisconnected();
    this.deps.onStateChange();
  }

  private async startInitial(ctx: RelayStartContext): Promise<void> {
    const expectedGeneration = ++this.generation;
    let identity: Ed25519Keypair;
    try {
      identity = await this.deps.loadIdentity();
    } catch (error) {
      if (!this.isOperationCurrent(expectedGeneration)) return;
      if (this.deps.handleIdentityError(error, ctx)) return;
      throw error;
    }
    if (!this.isOperationCurrent(expectedGeneration)) return;

    this.identity = identity;
    const resolution = this.deps.resolveRelayUrl();
    this.currentRelayUrl = resolution.url;
    this.currentState = "started";
    this.deps.onStateChange();
    this.notify(ctx, this.deps.describeConnection(resolution));

    let options: HostConnectOptions;
    try {
      options = await this.deps.buildConnectOptions(ctx.cwd);
    } catch (error) {
      this.handleConnectionFailure(expectedGeneration, resolution.url, ctx, error);
      return;
    }
    if (!this.isReconnectCurrent(expectedGeneration)) return;

    const candidate = this.deps.createClient(resolution.url, identity);
    this.pendingCandidate = candidate;
    try {
      await candidate.connect(options);
    } catch (error) {
      this.clearCandidate(candidate, true);
      this.handleConnectionFailure(expectedGeneration, resolution.url, ctx, error);
      return;
    }
    if (!this.isReconnectCurrent(expectedGeneration) || this.pendingCandidate !== candidate) {
      this.closeCandidateOnce(candidate);
      return;
    }

    this.pendingCandidate = null;
    this.activeRelay = candidate;
    this.reconnectAttempt = 0;
    candidate.on("close", () => this.onRelayClose(candidate));
    this.deps.onConnected(candidate, ctx);
    this.deps.onStateChange();
  }

  private scheduleReconnect(url: string): void {
    if (!this.identity || this.isDisposed || this.currentState !== "started") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const expectedGeneration = ++this.generation;
    const delay = RECONNECT_BACKOFFS_MS[Math.min(this.reconnectAttempt++, RECONNECT_BACKOFFS_MS.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isReconnectCurrent(expectedGeneration)) return;
      void this.reconnect(url, expectedGeneration);
    }, delay);
  }

  private async reconnect(url: string, expectedGeneration: number): Promise<void> {
    const identity = this.identity;
    if (!identity || !this.isReconnectCurrent(expectedGeneration)) return;

    let options: HostConnectOptions;
    try {
      options = await this.deps.buildConnectOptions();
    } catch {
      if (this.isReconnectCurrent(expectedGeneration)) {
        this.deps.onStateChange();
        this.scheduleReconnect(url);
      }
      return;
    }
    if (!this.isReconnectCurrent(expectedGeneration) || this.identity !== identity) return;

    const candidate = this.deps.createClient(url, identity);
    this.pendingCandidate = candidate;
    try {
      await candidate.connect(options);
    } catch {
      this.clearCandidate(candidate, true);
      if (this.isReconnectCurrent(expectedGeneration)) {
        this.deps.onStateChange();
        this.scheduleReconnect(url);
      }
      return;
    }
    if (!this.isReconnectCurrent(expectedGeneration) || this.pendingCandidate !== candidate) {
      this.closeCandidateOnce(candidate);
      return;
    }

    this.pendingCandidate = null;
    this.activeRelay = candidate;
    this.reconnectAttempt = 0;
    candidate.on("close", () => this.onRelayClose(candidate));
    this.deps.onConnected(candidate);
    this.deps.onStateChange();
  }

  private onRelayClose(closed: RelayClient): void {
    if (closed !== this.activeRelay || this.currentState === "idle") return;
    this.activeRelay = null;
    this.deps.onDisconnected();
    this.deps.onStateChange();
    if (this.currentRelayUrl) this.scheduleReconnect(this.currentRelayUrl);
  }

  private handleConnectionFailure(expectedGeneration: number, url: string, ctx: RelayStartContext, error: unknown): void {
    if (!this.isReconnectCurrent(expectedGeneration)) return;
    this.notify(ctx, `[remote-pi] Relay unavailable; reconnecting in background: ${String(error)}`, "warning");
    this.deps.onStateChange();
    this.scheduleReconnect(url);
  }

  private clearCandidate(candidate: RelayClient, close: boolean): void {
    if (this.pendingCandidate !== candidate) return;
    this.pendingCandidate = null;
    if (close) this.closeCandidateOnce(candidate);
  }

  private closeCandidateOnce(candidate: RelayClient): void {
    if (this.closedCandidates.has(candidate)) return;
    this.closedCandidates.add(candidate);
    candidate.close();
  }

  private clearInitialAttempt(attempt: Promise<InitialRelayResult>, cancel: () => void): void {
    if (this.initialAttempt === attempt) this.initialAttempt = null;
    if (this.cancelInitialAttempt === cancel) this.cancelInitialAttempt = null;
  }

  private isOperationCurrent(expected: number): boolean {
    return !this.isDisposed && this.generation === expected;
  }

  private isReconnectCurrent(expected: number): boolean {
    return this.currentState === "started" && this.isOperationCurrent(expected);
  }

  private notify(ctx: RelayStartContext, message: string, kind: "info" | "warning" = "info"): void {
    try { ctx.ui.notify(message, kind); } catch { /* stale context */ }
  }
}
