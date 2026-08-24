const LOCK_NAME = "remote-pi-relay";
const STORAGE_KEY = "remote-pi-relay-lock";
const LEASE_MS = 6000;
const HEARTBEAT_MS = 2000;

type LockMessage = { type: "released" } | { type: "acquired"; token: string };
type LockAvailabilityListener = () => void;
type LockLostListener = () => void;

function makeToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Keeps the Relay WebSocket in one same-origin app context at a time. */
export class RelayConnectionLock {
  private readonly token = makeToken();
  private readonly listeners = new Set<LockAvailabilityListener>();
  private readonly lostListeners = new Set<LockLostListener>();
  private readonly channel: BroadcastChannel | null;
  private releaseWebLock: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private held = false;

  constructor() {
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("remote-pi-connection");
    this.channel?.addEventListener("message", (event: MessageEvent<LockMessage>) => {
      if (event.data?.type === "released") this.notifyAvailable();
      if (event.data?.type === "acquired" && event.data.token !== this.token && this.heartbeatTimer && !this.hasValidStorageLease()) this.revokeLost();
    });
    if (typeof window !== "undefined") window.addEventListener("storage", this.handleStorage);
  }

  async acquire(): Promise<boolean> {
    if (this.held && this.ensureHeld()) return true;
    if (typeof navigator !== "undefined" && "locks" in navigator && navigator.locks) return this.acquireWebLock();
    return this.acquireStorageLease();
  }

  onAvailable(listener: LockAvailabilityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLost(listener: LockLostListener): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  ensureHeld(): boolean {
    if (!this.held) return false;
    if (!this.heartbeatTimer || this.hasValidStorageLease()) return true;
    this.revokeLost();
    return false;
  }

  release(): void {
    if (!this.held) return;
    if (this.releaseWebLock) {
      this.releaseWebLock();
      this.releaseWebLock = null;
      return;
    }
    this.held = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      const current = this.readStorageLease();
      if (current?.token === this.token) localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage can disappear while a private browsing context is closing.
    }
    this.broadcastRelease();
  }

  dispose(): void {
    this.release();
    this.channel?.close();
    if (typeof window !== "undefined") window.removeEventListener("storage", this.handleStorage);
    this.listeners.clear();
    this.lostListeners.clear();
  }

  private async acquireWebLock(): Promise<boolean> {
    let resolveAcquired!: (value: boolean) => void;
    let resolveRelease!: () => void;
    let released = false;
    const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve; });
    const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolveAcquired(false);
        return;
      }
      this.held = true;
      this.releaseWebLock = () => {
        if (released) return;
        released = true;
        resolveRelease();
      };
      resolveAcquired(true);
      await release;
      this.held = false;
      this.releaseWebLock = null;
      this.broadcastRelease();
    }).catch(() => {
      resolveAcquired(false);
    });
    return acquired;
  }

  private acquireStorageLease(): boolean {
    try {
      const current = this.readStorageLease();
      if (current && current.token !== this.token && current.expiresAt > Date.now()) return false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: this.token, expiresAt: Date.now() + LEASE_MS }));
      const confirmed = this.readStorageLease();
      if (confirmed?.token !== this.token) return false;
      this.held = true;
      this.broadcastAcquired();
      this.heartbeatTimer = setInterval(() => {
        try {
          const lease = this.readStorageLease();
          if (lease?.token === this.token && lease.expiresAt > Date.now()) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: this.token, expiresAt: Date.now() + LEASE_MS }));
          else this.revokeLost();
        } catch {
          this.revokeLost();
        }
      }, HEARTBEAT_MS);
      return true;
    } catch {
      // A browser with no usable shared storage cannot coordinate tabs; keep it online.
      this.held = true;
      return true;
    }
  }

  private hasValidStorageLease(): boolean {
    try {
      const lease = this.readStorageLease();
      return lease?.token === this.token && lease.expiresAt > Date.now();
    } catch {
      return false;
    }
  }

  private revokeLost(): void {
    if (!this.held || this.releaseWebLock) return;
    this.held = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const listener of this.lostListeners) listener();
  }

  private readStorageLease(): { token: string; expiresAt: number } | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
      return typeof value.token === "string" && typeof value.expiresAt === "number" ? value as { token: string; expiresAt: number } : null;
    } catch {
      return null;
    }
  }

  private readonly handleStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY && event.newValue === null) this.notifyAvailable();
  };

  private broadcastAcquired(): void {
    try {
      this.channel?.postMessage({ type: "acquired", token: this.token } satisfies LockMessage);
    } catch {
      // BroadcastChannel is optional and can close during tab teardown.
    }
  }

  private broadcastRelease(): void {
    try {
      this.channel?.postMessage({ type: "released" } satisfies LockMessage);
    } catch {
      // The tab may close the channel immediately after releasing the lock.
    }
  }

  private notifyAvailable(): void {
    for (const listener of this.listeners) listener();
  }
}
