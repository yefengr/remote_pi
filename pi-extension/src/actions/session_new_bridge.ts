import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { V2ActionFrame } from "../timeline/v2_service.js";
import { handleSessionNew, type ActionCtx, type ActionReplySender } from "./handlers.js";

const DEFAULT_TIMEOUT_MS = 5_000;

type SessionNewFrame = Extract<V2ActionFrame, { type: "session_new" }>;
type PendingSessionNew = {
  sender: ActionReplySender;
  frame: SessionNewFrame;
  timer: ReturnType<typeof setTimeout>;
  running?: boolean;
};

export interface SessionNewBridgeOptions {
  getPi(): ExtensionAPI | null;
  onCommandContext(ctx: ExtensionCommandContext): void;
  onReplaced(ctx: ActionCtx): void;
  onFinished(): void;
}

/** Bridges a remote action to Pi's command-only, process-local newSession API. */
export class SessionNewBridge {
  private readonly pending = new Map<string, PendingSessionNew>();
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private running = false;
  private switchPermit = false;

  constructor(private readonly options: SessionNewBridgeOptions) {}

  dispatch(sender: ActionReplySender, frame: SessionNewFrame): void {
    const pi = this.options.getPi();
    if (!pi) {
      sender.send({ type: "action_error", in_reply_to: frame.id, action: "session_new", error: "session replacement is unavailable" });
      return;
    }
    if (this.running || this.pending.size > 0) {
      sender.send({ type: "action_error", in_reply_to: frame.id, action: "session_new", error: "session replacement is already in progress" });
      return;
    }

    const token = randomUUID();
    const pending = {} as PendingSessionNew;
    pending.sender = sender;
    pending.frame = frame;
    pending.timer = setTimeout(
      () => this.fail(token, pending, "session replacement dispatch timed out"),
      this.timeoutMs,
    );
    pending.timer.unref();
    this.pending.set(token, pending);

    try {
      void Promise.resolve(pi.sendUserMessage(`/remote-pi internal-session-new ${token}`, { expandPromptTemplates: true }))
        .catch(() => this.fail(token, pending, "session replacement dispatch failed"));
    } catch {
      this.fail(token, pending, "session replacement dispatch failed");
    }
  }

  async run(token: string, ctx: ExtensionCommandContext): Promise<void> {
    const normalized = token.trim();
    const pending = this.pending.get(normalized);
    if (!pending || pending.running || this.running) return;
    clearTimeout(pending.timer);
    pending.running = true;
    this.running = true;
    this.switchPermit = true;
    this.options.onCommandContext(ctx);
    const sender: ActionReplySender = { send: (message) => this.complete(normalized, pending, message) };
    try {
      await handleSessionNew(ctx, sender, pending.frame, this.options.onReplaced);
    } finally {
      this.switchPermit = false;
      this.running = false;
      this.options.onFinished();
    }
  }

  beforeSwitch(reason: "new" | "resume"): { cancel: true } | undefined {
    if (!this.running) return undefined;
    if (reason === "new" && this.switchPermit) { this.switchPermit = false; return undefined; }
    return { cancel: true };
  }

  beforeFork(): { cancel: true } | undefined { return this.running ? { cancel: true } : undefined; }

  isRunning(): boolean { return this.running; }

  clear(error = "session replacement cancelled"): void {
    for (const [token, pending] of [...this.pending]) this.fail(token, pending, error);
  }

  setTimeoutForTest(timeoutMs: number): void {
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  private fail(token: string, pending: PendingSessionNew, error: string): void {
    this.complete(token, pending, { type: "action_error", in_reply_to: pending.frame.id, action: "session_new", error });
  }

  private complete(token: string, pending: PendingSessionNew, message: Parameters<ActionReplySender["send"]>[0]): void {
    if (this.pending.get(token) !== pending) return;
    this.pending.delete(token);
    clearTimeout(pending.timer);
    pending.sender.send(message);
  }
}
