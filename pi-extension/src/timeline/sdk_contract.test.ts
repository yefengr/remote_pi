import { describe, expect, test } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const REMOTE_PI_MARKER = "remote-pi:timeline-v2";
const TEST_TOOL_NAME = "sdk_contract_tool";
const TEST_API_KEY = "sdk-contract-local-key";

type TestSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type BranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type MessageInput = Parameters<SessionManager["appendMessage"]>[0];

type FakeAssistantMessage = {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: "stop" | "toolUse";
  timestamp: number;
};

type LocalStreamFn = TestSession["agent"]["streamFn"];
type LocalStream = Awaited<ReturnType<LocalStreamFn>>;

function makeAssistant(
  content: FakeAssistantMessage["content"],
  stopReason: FakeAssistantMessage["stopReason"],
): FakeAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "sdk-contract",
    model: "sdk-contract-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function fakeStream(message: FakeAssistantMessage): LocalStream {
  const doneReason = message.stopReason === "toolUse" ? "toolUse" : "stop";
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      yield { type: "done", reason: doneReason, message };
    },
    async result() {
      return message;
    },
  };

  // AssistantMessageEventStream has private nominal state; this is the test provider fake seam.
  return stream as unknown as LocalStream;
}

function textStream(): LocalStreamFn {
  return () => fakeStream(makeAssistant([{ type: "text", text: "local assistant response" }], "stop"));
}

function toolThenTextStream(): LocalStreamFn {
  return (_model, context) => {
    const hasToolResult = context.messages.some((message) => message.role === "toolResult");
    if (hasToolResult) {
      return fakeStream(makeAssistant([{ type: "text", text: "tool result consumed" }], "stop"));
    }
    return fakeStream(makeAssistant([{
      type: "toolCall",
      id: "sdk-contract-tool-call",
      name: TEST_TOOL_NAME,
      arguments: {},
    }], "toolUse"));
  };
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timeout);
        reject(reason);
      },
    );
  });
}

async function waitForAgentIdle(session: TestSession, label: string): Promise<void> {
  await waitFor(
    new Promise<void>((resolve) => {
      const check = (): void => {
        if (!session.isStreaming) resolve();
        else setImmediate(check);
      };
      check();
    }),
    label,
  );
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object"
      && part !== null
      && "type" in part
      && part.type === "text"
      && "text" in part
      && typeof part.text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
}

function expectSubsequence(events: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const event of events) {
    if (event === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  throw new Error(`Expected event subsequence not found: ${expected.join(" -> ")}`);
}

type PublicSendUserMessage = (
  content: string,
  options?: { deliverAs?: "steer" | "followUp" },
) => void;

type StreamGate = {
  started: Deferred<void>;
  release: Deferred<void>;
};

function gatedTextStream(message: FakeAssistantMessage, gate: StreamGate): LocalStream {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      gate.started.resolve(undefined);
      await gate.release.promise;
      yield { type: "done", reason: "stop" as const, message };
    },
    async result() {
      await gate.release.promise;
      return message;
    },
  };
  return stream as unknown as LocalStream;
}

function firstAssistantGatedStream(gate: StreamGate): LocalStreamFn {
  let invocation = 0;
  return () => {
    invocation += 1;
    const message = makeAssistant([{ type: "text", text: "gated local assistant response" }], "stop");
    return invocation === 1 ? gatedTextStream(message, gate) : fakeStream(message);
  };
}

function toolThenGatedTextStream(gate: StreamGate): LocalStreamFn {
  let invocation = 0;
  return () => {
    invocation += 1;
    if (invocation === 1) {
      return fakeStream(makeAssistant([{
        type: "toolCall",
        id: "sdk-contract-epoch-tool-call",
        name: TEST_TOOL_NAME,
        arguments: {},
      }], "toolUse"));
    }
    const message = makeAssistant([{ type: "text", text: "gated epoch tool response" }], "stop");
    return invocation === 2 ? gatedTextStream(message, gate) : fakeStream(message);
  };
}

async function createHarness(options: {
  sessionManager: SessionManager;
  extensionFactories?: ExtensionFactory[];
  streamFn?: LocalStreamFn;
  enableExtensionTools?: boolean;
  cwd?: string;
  agentDir?: string;
}): Promise<TestSession> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? cwd;
  const auth = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(auth);
  const model = modelRegistry.getAll()[0];
  if (!model) throw new Error("The in-memory ModelRegistry has no built-in model");
  auth.setRuntimeApiKey(model.provider, TEST_API_KEY);

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: options.extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage: auth,
    modelRegistry,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: options.sessionManager,
    noTools: options.enableExtensionTools ? "builtin" : "all",
  });
  session.agent.streamFn = options.streamFn ?? textStream();
  return session;
}

type MarkerEntry = Extract<BranchEntry, { type: "custom" }> & { customType: typeof REMOTE_PI_MARKER };

function hasMessageEntry(entries: readonly BranchEntry[], message: unknown): boolean {
  return entries.some((entry) => entry.type === "message" && entry.message === message);
}

function appendUser(manager: SessionManager, text: string): string {
  return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as MessageInput);
}

function appendAssistant(manager: SessionManager, text: string): string {
  return manager.appendMessage(makeAssistant([{ type: "text", text }], "stop") as MessageInput);
}

/**
 * Test-only recovery scanner for the plan/63 marker adjacency contract.
 * It is deliberately local: production recovery remains out of scope for phase 0.
 */
type ScanEntry = BranchEntry | { type: string };

function isMarker(entry: ScanEntry | undefined): entry is MarkerEntry {
  return entry?.type === "custom"
    && "customType" in entry
    && entry.customType === REMOTE_PI_MARKER;
}

function scanTargetAfterMarker(
  entries: readonly ScanEntry[],
  markerIndex: number,
  targetRole: "user" | "assistant" | "toolResult",
): BranchEntry | undefined {
  for (let index = markerIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isMarker(entry)) return undefined;

    if (entry.type === "custom") continue;
    if (entry.type !== "message" || !("message" in entry)) return undefined;
    return entry.message.role === targetRole ? entry : undefined;
  }
  return undefined;
}

interface LifecycleRecord {
  role: "user" | "assistant" | "toolResult";
  markerId: string;
  targetMessage?: unknown;
  markerVisibleDuringEnd?: boolean;
  targetVisibleDuringEnd?: boolean;
  targetVisibleAfterMacrotask?: boolean;
}

function lifecycleExtension(records: LifecycleRecord[], toolExecutionCount: { value: number }): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: TEST_TOOL_NAME,
      label: "SDK contract tool",
      description: "Returns a deterministic local result for lifecycle coverage.",
      parameters: Type.Object({}),
      execute: async () => {
        toolExecutionCount.value += 1;
        return {
          content: [{ type: "text", text: "deterministic tool result" }],
          details: {},
        };
      },
    });

    pi.on("message_start", (event, ctx) => {
      const role = event.message.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") return;

      pi.appendEntry(REMOTE_PI_MARKER, { role });
      const marker = ctx.sessionManager.getBranch().at(-1);
      if (!isMarker(marker)) throw new Error("marker was not appended during message_start");
      records.push({ role, markerId: marker.id });
    });

    pi.on("message_end", (event, ctx) => {
      const role = event.message.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
      const record = records.find((candidate) => candidate.role === role && candidate.targetMessage === undefined);
      if (!record) return;

      record.targetMessage = event.message;
      const branch = ctx.sessionManager.getBranch();
      record.markerVisibleDuringEnd = branch.some((entry) => entry.id === record.markerId);
      record.targetVisibleDuringEnd = hasMessageEntry(branch, event.message);
      setImmediate(() => {
        record.targetVisibleAfterMacrotask = hasMessageEntry(ctx.sessionManager.getBranch(), event.message);
      });
    });
  };
}

describe("plan/63 SDK timeline contracts", () => {
  test("persists user, assistant, and toolResult only after their message_end handlers", async () => {
    const records: LifecycleRecord[] = [];
    const toolExecutionCount = { value: 0 };
    const sessionManager = SessionManager.inMemory(process.cwd());
    const session = await createHarness({
      sessionManager,
      extensionFactories: [lifecycleExtension(records, toolExecutionCount)],
      streamFn: toolThenTextStream(),
      enableExtensionTools: true,
    });

    try {
      await session.prompt("exercise the local lifecycle");
      await nextMacrotask();

      expect(records.map((record) => record.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      for (const record of records) {
        expect(record.markerVisibleDuringEnd).toBe(true);
        expect(record.targetVisibleDuringEnd).toBe(false);
        expect(record.targetVisibleAfterMacrotask).toBe(true);
      }
      expect(toolExecutionCount.value).toBe(1);
      expect(records.find((record) => record.role === "toolResult")?.targetMessage).toMatchObject({
        role: "toolResult",
        toolName: TEST_TOOL_NAME,
        isError: false,
        content: [{ type: "text", text: "deterministic tool result" }],
      });

      const branch = sessionManager.getBranch();
      expect(branch.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      for (const record of records) {
        const markerIndex = branch.findIndex((entry) => entry.id === record.markerId);
        const targetIndex = branch.findIndex((entry) => hasMessageEntry([entry], record.targetMessage));
        expect(record.targetMessage).toBeDefined();
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        expect(targetIndex).toBe(markerIndex + 1);
        expect(branch[targetIndex]!.parentId).toBe(record.markerId);
      }
    } finally {
      session.dispose();
    }
  });

  test("interleaves marker -> custom -> same target through two ExtensionRunner factories", async () => {
    const lifecycle: { markerId?: string; targetMessage?: unknown } = {};
    const markerFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event, ctx) => {
        if (event.message.role !== "user") return;

        lifecycle.targetMessage = event.message;
        pi.appendEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
        const marker = ctx.sessionManager.getBranch().at(-1);
        if (!isMarker(marker)) throw new Error("marker was not appended during message_start");
        lifecycle.markerId = marker.id;
      });
    };
    const thirdPartyFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event) => {
        if (event.message.role === "user") {
          pi.appendEntry("third-party:metadata", { source: "third-party-extension" });
        }
      });
    };
    const sessionManager = SessionManager.inMemory(process.cwd());
    const session = await createHarness({
      sessionManager,
      extensionFactories: [markerFactory, thirdPartyFactory],
    });

    try {
      await session.prompt("target after interleaved custom entry");

      const branch = sessionManager.getBranch();
      const markerIndex = branch.findIndex((entry) => entry.id === lifecycle.markerId);
      const targetIndex = branch.findIndex((entry) => hasMessageEntry([entry], lifecycle.targetMessage));
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      expect(branch[markerIndex + 1]).toMatchObject({ type: "custom", customType: "third-party:metadata" });
      expect(targetIndex).toBe(markerIndex + 2);

      const target = branch[targetIndex];
      expect(target?.type).toBe("message");
      if (target?.type !== "message") throw new Error("interleaved target message was not persisted");
      expect(target.message).toBe(lifecycle.targetMessage);
      expect(target.message.role).toBe("user");
      expect(target.parentId).toBe(branch[markerIndex + 1]?.id);
      expect(scanTargetAfterMarker(branch, markerIndex, "user")?.id).toBe(target.id);
    } finally {
      session.dispose();
    }
  });

  test("defers custom_message after target because message_start is streaming and sendMessage uses steer", async () => {
    const lifecycle: { markerId?: string; targetMessage?: unknown } = {};
    const markerFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event, ctx) => {
        if (event.message.role !== "user") return;

        lifecycle.targetMessage = event.message;
        pi.appendEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
        const marker = ctx.sessionManager.getBranch().at(-1);
        if (!isMarker(marker)) throw new Error("marker was not appended during message_start");
        lifecycle.markerId = marker.id;
      });
    };
    const thirdPartyFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event) => {
        if (event.message.role === "user") {
          pi.sendMessage({
            customType: "third-party:context",
            content: "legal extension context",
            display: false,
          });
        }
      });
    };
    const sessionManager = SessionManager.inMemory(process.cwd());
    const session = await createHarness({
      sessionManager,
      extensionFactories: [markerFactory, thirdPartyFactory],
    });

    try {
      await session.prompt("target before deferred custom message");

      const branch = sessionManager.getBranch();
      const markerIndex = branch.findIndex((entry) => entry.id === lifecycle.markerId);
      const targetIndex = branch.findIndex((entry) => hasMessageEntry([entry], lifecycle.targetMessage));
      const customMessageIndex = branch.findIndex(
        (entry) => entry.type === "custom_message" && entry.customType === "third-party:context",
      );
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      expect(targetIndex).toBe(markerIndex + 1);
      expect(customMessageIndex).toBeGreaterThan(targetIndex);
      expect(branch[customMessageIndex]).toMatchObject({
        type: "custom_message",
        customType: "third-party:context",
      });

      const target = branch[targetIndex];
      expect(target?.type).toBe("message");
      if (target?.type !== "message") throw new Error("deferred custom_message target was not persisted");
      expect(target.message).toBe(lifecycle.targetMessage);
      expect(target.message.role).toBe("user");
      expect(target.parentId).toBe(lifecycle.markerId);
      expect(scanTargetAfterMarker(branch, markerIndex, "user")?.id).toBe(target.id);
    } finally {
      session.dispose();
    }
  });

  test("scanner skips non-marker metadata custom; all non-custom entries hard boundaries", () => {
    const nextMarkerManager = SessionManager.inMemory(process.cwd());
    const firstMarker = nextMarkerManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    const secondMarker = nextMarkerManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    const secondTarget = appendUser(nextMarkerManager, "target after second marker");
    const nextMarkerBranch = nextMarkerManager.getBranch();
    expect(scanTargetAfterMarker(nextMarkerBranch, nextMarkerBranch.findIndex((entry) => entry.id === firstMarker), "user")).toBeUndefined();
    expect(scanTargetAfterMarker(nextMarkerBranch, nextMarkerBranch.findIndex((entry) => entry.id === secondMarker), "user")?.id).toBe(secondTarget);

    const compatibleCustomManager = SessionManager.inMemory(process.cwd());
    const compatibleCustomMarker = compatibleCustomManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    compatibleCustomManager.appendCustomEntry("third-party:metadata", { visible: false });
    const compatibleCustomTarget = appendUser(compatibleCustomManager, "target after third-party custom");
    const compatibleCustomBranch = compatibleCustomManager.getBranch();
    expect(scanTargetAfterMarker(
      compatibleCustomBranch,
      compatibleCustomBranch.findIndex((entry) => entry.id === compatibleCustomMarker),
      "user",
    )?.id).toBe(compatibleCustomTarget);

    const incompatibleManager = SessionManager.inMemory(process.cwd());
    const incompatibleMarker = incompatibleManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    appendAssistant(incompatibleManager, "incompatible assistant");
    const incompatibleBranch = incompatibleManager.getBranch();
    expect(scanTargetAfterMarker(incompatibleBranch, incompatibleBranch.findIndex((entry) => entry.id === incompatibleMarker), "user")).toBeUndefined();

    const hardBoundaryFactories: ReadonlyArray<(manager: SessionManager, marker: string) => void> = [
      (manager) => { manager.appendCustomMessageEntry("third-party:context", "context", false); },
      (manager) => { manager.appendThinkingLevelChange("low"); },
      (manager) => { manager.appendModelChange("sdk-contract", "model"); },
      (manager, marker) => { manager.appendLabelChange(marker, "bookmark"); },
      (manager) => { manager.appendSessionInfo("session name"); },
      (manager, marker) => { manager.appendCompaction("summary", marker, 0); },
      (manager, marker) => { manager.branchWithSummary(marker, "branch summary"); },
    ];
    for (const appendBoundary of hardBoundaryFactories) {
      const manager = SessionManager.inMemory(process.cwd());
      const marker = manager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
      appendBoundary(manager, marker);
      appendUser(manager, "unreachable target after hard boundary");
      const branch = manager.getBranch();
      expect(scanTargetAfterMarker(branch, branch.findIndex((entry) => entry.id === marker), "user")).toBeUndefined();
    }

    const unknownBoundary = [
      { type: "custom", id: "marker", parentId: null, timestamp: "0", customType: REMOTE_PI_MARKER },
      { type: "unknown_future_entry" },
    ] satisfies readonly ScanEntry[];
    expect(scanTargetAfterMarker(unknownBoundary, 0, "user")).toBeUndefined();
  });

  test("later handled input leaves a FIFO correlation orphan and consumes the wrong real user start", async () => {
    const expectedFifo: string[] = [];
    const startedUsers: Array<{ text: string; consumedRequestId?: string }> = [];
    let send!: PublicSendUserMessage;
    const handled = deferred<void>();
    const firstInputObserved = deferred<void>();
    const firstInputMayFinish = deferred<void>();
    const secondAgentEnded = deferred<void>();
    let inputCount = 0;

    const earlyRemotePiFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.on("input", (event) => {
        if (event.source !== "extension") return;
        expectedFifo.push(event.text);
      });
    };
    const laterHandlerFactory: ExtensionFactory = (pi) => {
      pi.on("input", async (event) => {
        if (event.source !== "extension") return;
        inputCount += 1;
        if (inputCount !== 1) return;
        firstInputObserved.resolve(undefined);
        await firstInputMayFinish.promise;
        handled.resolve(undefined);
        return { action: "handled" };
      });
    };
    const observerFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        startedUsers.push({
          text: messageText(event.message.content),
          consumedRequestId: expectedFifo.shift(),
        });
      });
      pi.on("agent_end", () => {
        secondAgentEnded.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [earlyRemotePiFactory, laterHandlerFactory, observerFactory],
    });

    try {
      send("first handled request");
      await waitFor(firstInputObserved.promise, "first handled input");
      firstInputMayFinish.resolve(undefined);
      await waitFor(handled.promise, "handled input result");
      send("second real request");
      await waitFor(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (startedUsers.length === 1) resolve();
            else setImmediate(check);
          };
          check();
        }),
        "second user message_start",
      );
      await waitFor(secondAgentEnded.promise, "second real agent end");
      await waitForAgentIdle(session, "second real request becoming idle");

      expect(startedUsers).toEqual([{
        text: "second real request",
        consumedRequestId: "first handled request",
      }]);
      expect(expectedFifo).toEqual(["second real request"]);
    } finally {
      session.dispose();
    }
  });

  test("async input handlers reverse FIFO correlation when the later request starts before the earlier request", async () => {
    const fifo: string[] = [];
    const startedUsers: Array<{ text: string; consumedRequestId?: string }> = [];
    let send!: PublicSendUserMessage;
    const firstHandlerEntered = deferred<void>();
    const releaseFirstHandler = deferred<void>();
    const firstHandlerFinished = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const laterAgentEnded = deferred<void>();
    const earlierAgentEnded = deferred<void>();
    let agentEndCount = 0;
    let inputCount = 0;

    const remotePiLedgerFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.on("input", async (event) => {
        if (event.source !== "extension") return;
        fifo.push(event.text);
        inputCount += 1;
        if (inputCount !== 1) return;
        firstHandlerEntered.resolve(undefined);
        await releaseFirstHandler.promise;
        firstHandlerFinished.resolve(undefined);
      });
    };
    const observerFactory: ExtensionFactory = (pi) => {
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        startedUsers.push({ text: messageText(event.message.content), consumedRequestId: fifo.shift() });
        if (startedUsers.length === 1) firstStarted.resolve(undefined);
        if (startedUsers.length === 2) secondStarted.resolve(undefined);
      });
      pi.on("agent_end", () => {
        agentEndCount += 1;
        if (agentEndCount === 1) laterAgentEnded.resolve(undefined);
        if (agentEndCount === 2) earlierAgentEnded.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [remotePiLedgerFactory, observerFactory],
    });

    try {
      send("earlier idle request");
      await waitFor(firstHandlerEntered.promise, "earlier input handler");
      send("later idle request");
      await waitFor(firstStarted.promise, "later user message_start");
      await waitFor(laterAgentEnded.promise, "later agent end");
      await waitForAgentIdle(session, "later request becoming idle");
      releaseFirstHandler.resolve(undefined);
      await waitFor(firstHandlerFinished.promise, "earlier delayed handler completion");
      await waitFor(secondStarted.promise, "earlier user message_start");
      await waitFor(earlierAgentEnded.promise, "earlier agent end");
      await waitForAgentIdle(session, "earlier request becoming idle");

      expect(startedUsers).toEqual([
        { text: "later idle request", consumedRequestId: "earlier idle request" },
        { text: "earlier idle request", consumedRequestId: "later idle request" },
      ]);
      expect(fifo).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  test("AsyncLocalStorage keeps each requestId correct when async input handlers start later before earlier", async () => {
    const correlation = new AsyncLocalStorage<{ requestId: string }>();
    const startedUsers: Array<{ text: string; requestId?: string }> = [];
    const inputIdleStates: boolean[] = [];
    let send!: PublicSendUserMessage;
    const firstHandlerEntered = deferred<void>();
    const releaseFirstHandler = deferred<void>();
    const firstHandlerFinished = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const laterAgentEnded = deferred<void>();
    const earlierAgentEnded = deferred<void>();
    let agentEndCount = 0;
    let inputCount = 0;

    const asyncExtensionFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.on("input", async (event, ctx) => {
        if (event.source !== "extension") return;
        inputIdleStates.push(ctx.isIdle());
        inputCount += 1;
        if (inputCount !== 1) return;
        firstHandlerEntered.resolve(undefined);
        await releaseFirstHandler.promise;
        firstHandlerFinished.resolve(undefined);
      });
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        startedUsers.push({ text: messageText(event.message.content), requestId: correlation.getStore()?.requestId });
        if (startedUsers.length === 1) firstStarted.resolve(undefined);
        if (startedUsers.length === 2) secondStarted.resolve(undefined);
      });
      pi.on("agent_end", () => {
        agentEndCount += 1;
        if (agentEndCount === 1) laterAgentEnded.resolve(undefined);
        if (agentEndCount === 2) earlierAgentEnded.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [asyncExtensionFactory],
    });

    try {
      correlation.run({ requestId: "request-earlier" }, () => send("earlier ALS request"));
      await waitFor(firstHandlerEntered.promise, "earlier ALS input handler");
      correlation.run({ requestId: "request-later" }, () => send("later ALS request"));
      await waitFor(firstStarted.promise, "later ALS user message_start");
      await waitFor(laterAgentEnded.promise, "later ALS agent end");
      await waitForAgentIdle(session, "later ALS request becoming idle");
      releaseFirstHandler.resolve(undefined);
      await waitFor(firstHandlerFinished.promise, "earlier ALS delayed handler completion");
      await waitFor(secondStarted.promise, "earlier ALS user message_start");
      await waitFor(earlierAgentEnded.promise, "earlier ALS agent end");

      expect(startedUsers).toEqual([
        { text: "later ALS request", requestId: "request-later" },
        { text: "earlier ALS request", requestId: "request-earlier" },
      ]);
      expect(inputIdleStates).toEqual([true, true]);
    } finally {
      session.dispose();
    }
  });

  test("steer delays user message_start beyond the originating ALS scope without a new agent epoch", async () => {
    const correlation = new AsyncLocalStorage<{ requestId: string }>();
    const gate: StreamGate = { started: deferred<void>(), release: deferred<void>() };
    let send!: PublicSendUserMessage;
    const events: string[] = [];
    const users: Array<{ text: string; requestId?: string; epoch: number }> = [];
    const steerStarted = deferred<void>();
    let epoch = 0;

    const observerFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.on("agent_start", () => {
        epoch += 1;
        events.push(`agent_start:${epoch}`);
      });
      pi.on("agent_end", () => { events.push(`agent_end:${epoch}`); });
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        const user = {
          text: messageText(event.message.content),
          requestId: correlation.getStore()?.requestId,
          epoch,
        };
        users.push(user);
        events.push(`user:${user.text}:${epoch}`);
        if (user.text === "steer during streaming") steerStarted.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [observerFactory],
      streamFn: firstAssistantGatedStream(gate),
    });

    try {
      const rootPrompt = session.prompt("root streaming request");
      await waitFor(gate.started.promise, "root assistant stream start");
      correlation.run({ requestId: "steer-request" }, () => {
        send("steer during streaming", { deliverAs: "steer" });
      });
      gate.release.resolve(undefined);
      await waitFor(steerStarted.promise, "steer user message_start");
      await rootPrompt;

      expect(users).toEqual([
        { text: "root streaming request", requestId: undefined, epoch: 1 },
        { text: "steer during streaming", requestId: undefined, epoch: 1 },
      ]);
      expect(events).toContain("agent_start:1");
      expect(events).toContain("agent_end:1");
      expect(events.indexOf("user:steer during streaming:1")).toBeLessThan(events.indexOf("agent_end:1"));
    } finally {
      session.dispose();
    }
  });

  test("agent_end synchronous sendUserMessage starts a new epoch and loses its ALS scope", async () => {
    const correlation = new AsyncLocalStorage<{ requestId: string }>();
    const events: string[] = [];
    const users: Array<{ text: string; requestId?: string; epoch: number }> = [];
    const queuedStarted = deferred<void>();
    let epoch = 0;
    let queued = false;

    const observerFactory: ExtensionFactory = (pi) => {
      pi.on("agent_start", () => { epoch += 1; events.push(`agent_start:${epoch}`); });
      pi.on("agent_end", () => {
        events.push(`agent_end:${epoch}`);
        if (queued) return;
        queued = true;
        correlation.run({ requestId: "queued-sync" }, () => {
          pi.sendUserMessage("queued from agent_end", { deliverAs: "steer" });
        });
      });
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        const user = { text: messageText(event.message.content), requestId: correlation.getStore()?.requestId, epoch };
        users.push(user);
        events.push(`user:${user.text}:${epoch}`);
        if (user.text === "queued from agent_end") queuedStarted.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [observerFactory],
    });

    try {
      await session.prompt("root for synchronous queued continuation");
      await waitFor(queuedStarted.promise, "synchronous queued continuation start");

      expect(users).toEqual([
        { text: "root for synchronous queued continuation", requestId: undefined, epoch: 1 },
        { text: "queued from agent_end", requestId: undefined, epoch: 2 },
      ]);
      await waitForAgentIdle(session, "synchronous queued agent end");
      expect(events.filter((event) => event.startsWith("agent_start:"))).toEqual(["agent_start:1", "agent_start:2"]);
      expect(events.filter((event) => event.startsWith("agent_end:"))).toEqual(["agent_end:1", "agent_end:2"]);
    } finally {
      session.dispose();
    }
  });

  test("a Remote Pi queue drains on the next macrotask only after the agent is idle", async () => {
    const correlation = new AsyncLocalStorage<{ requestId: string }>();
    const events: string[] = [];
    const users: Array<{ text: string; requestId?: string }> = [];
    const gate: StreamGate = { started: deferred<void>(), release: deferred<void>() };
    const queuedDrained = deferred<void>();
    const rootAgentEnded = deferred<void>();
    const queuedAgentEnded = deferred<void>();
    const remoteQueue: Array<{ text: string; requestId: string }> = [];
    const drainIdleStates: boolean[] = [];
    const queuedInputIdleStates: boolean[] = [];
    let send!: PublicSendUserMessage;
    let session!: TestSession;
    let epoch = 0;
    let drainScheduled = false;

    const observerFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.on("agent_start", () => {
        epoch += 1;
        events.push(`agent_start:${epoch}`);
      });
      pi.on("input", (event, ctx) => {
        if (event.source === "extension" && event.text === "queued from Remote Pi PWA") {
          queuedInputIdleStates.push(ctx.isIdle());
        }
      });
      pi.on("message_start", (event) => {
        if (event.message.role !== "user" && event.message.role !== "assistant") return;
        const text = messageText(event.message.content);
        events.push(`message_start:${event.message.role}:${text}:${epoch}`);
        if (event.message.role === "user") {
          users.push({ text, requestId: correlation.getStore()?.requestId });
        }
      });
      pi.on("message_end", (event) => {
        if (event.message.role === "user" || event.message.role === "assistant") {
          events.push(`message_end:${event.message.role}:${messageText(event.message.content)}:${epoch}`);
        }
      });
      pi.on("agent_end", () => {
        events.push(`agent_end:${epoch}`);
        if (epoch === 2) {
          queuedAgentEnded.resolve(undefined);
          return;
        }
        rootAgentEnded.resolve(undefined);
        if (drainScheduled) return;
        drainScheduled = true;
        setImmediate(() => {
          drainIdleStates.push(!session.isStreaming);
          const next = remoteQueue.shift();
          expect(next).toBeDefined();
          if (!next) return;
          correlation.run({ requestId: next.requestId }, () => {
            send(next.text);
          });
          queuedDrained.resolve(undefined);
        });
      });
    };
    session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [observerFactory],
      streamFn: firstAssistantGatedStream(gate),
    });

    try {
      const rootPrompt = session.prompt("root for Remote Pi queue");
      await waitFor(gate.started.promise, "root assistant stream start");
      remoteQueue.push({ text: "queued from Remote Pi PWA", requestId: "remote-pwa-request" });
      expect(session.isStreaming).toBe(true);
      expect(remoteQueue).toHaveLength(1);
      gate.release.resolve(undefined);
      await waitFor(rootAgentEnded.promise, "root agent end");
      await waitFor(queuedDrained.promise, "Remote Pi queue drain");
      await rootPrompt;
      await waitFor(queuedAgentEnded.promise, "Remote Pi queued agent end");
      await waitForAgentIdle(session, "Remote Pi queued request becoming idle");

      expect(drainIdleStates).toEqual([true]);
      expect(queuedInputIdleStates).toEqual([true]);
      expect(remoteQueue).toEqual([]);
      expect(users).toEqual([
        { text: "root for Remote Pi queue", requestId: undefined },
        { text: "queued from Remote Pi PWA", requestId: "remote-pwa-request" },
      ]);
      expect(events).toContain("agent_start:2");
      expect(events.filter((event) => event.startsWith("agent_end:"))).toEqual(["agent_end:1", "agent_end:2"]);
      expectSubsequence(events, [
        "agent_start:1",
        "message_start:user:root for Remote Pi queue:1",
        "message_end:user:root for Remote Pi queue:1",
        "message_start:assistant:gated local assistant response:1",
        "message_end:assistant:gated local assistant response:1",
        "agent_end:1",
        "agent_start:2",
        "message_start:user:queued from Remote Pi PWA:2",
        "message_end:user:queued from Remote Pi PWA:2",
        "message_start:assistant:gated local assistant response:2",
        "message_end:assistant:gated local assistant response:2",
        "agent_end:2",
      ]);
    } finally {
      gate.release.resolve(undefined);
      session.dispose();
    }
  });

  test("real tool, steer, synchronous queued continuation, and idle queued send expose their agent epochs", async () => {
    const events: string[] = [];
    const gate: StreamGate = { started: deferred<void>(), release: deferred<void>() };
    let send!: PublicSendUserMessage;
    const rootToolCount = { value: 0 };
    const steerStarted = deferred<void>();
    const synchronousQueuedStarted = deferred<void>();
    const idleQueuedStarted = deferred<void>();
    const epochOneEnded = deferred<void>();
    const epochTwoEnded = deferred<void>();
    const epochThreeEnded = deferred<void>();
    let epoch = 0;
    let synchronousQueued = false;
    let idleQueued = false;

    const epochFactory: ExtensionFactory = (pi) => {
      send = (content, options) => { pi.sendUserMessage(content, options); };
      pi.registerTool({
        name: TEST_TOOL_NAME,
        label: "SDK contract epoch tool",
        description: "Produces one deterministic local tool result.",
        parameters: Type.Object({}),
        execute: async () => {
          rootToolCount.value += 1;
          return { content: [{ type: "text", text: "epoch tool result" }], details: {} };
        },
      });
      pi.on("agent_start", () => { epoch += 1; events.push(`agent_start:${epoch}`); });
      pi.on("message_start", (event) => {
        if (event.message.role === "user") {
          const text = messageText(event.message.content);
          events.push(`message_start:user:${text}:${epoch}`);
          if (text === "epoch steer") steerStarted.resolve(undefined);
          if (text === "epoch synchronous queued") synchronousQueuedStarted.resolve(undefined);
          if (text === "epoch idle queued") idleQueuedStarted.resolve(undefined);
          return;
        }
        if (event.message.role === "assistant" || event.message.role === "toolResult") {
          const text = event.message.role === "assistant" ? messageText(event.message.content) : "";
          events.push(`message_start:${event.message.role}:${text}:${epoch}`);
        }
      });
      pi.on("message_end", (event) => {
        if (event.message.role !== "user" && event.message.role !== "assistant" && event.message.role !== "toolResult") return;
        const text = event.message.role === "assistant" ? messageText(event.message.content) : "";
        events.push(`message_end:${event.message.role}:${text}:${epoch}`);
      });
      pi.on("agent_end", () => {
        events.push(`agent_end:${epoch}`);
        if (epoch === 1) {
          epochOneEnded.resolve(undefined);
          if (!synchronousQueued) {
            synchronousQueued = true;
            pi.sendUserMessage("epoch synchronous queued", { deliverAs: "steer" });
          }
          return;
        }
        if (epoch === 2) {
          epochTwoEnded.resolve(undefined);
          if (!idleQueued) {
            idleQueued = true;
            setImmediate(() => { pi.sendUserMessage("epoch idle queued", { deliverAs: "steer" }); });
          }
          return;
        }
        if (epoch === 3) epochThreeEnded.resolve(undefined);
      });
    };
    const session = await createHarness({
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionFactories: [epochFactory],
      streamFn: toolThenGatedTextStream(gate),
      enableExtensionTools: true,
    });

    try {
      const rootPrompt = session.prompt("epoch root");
      await waitFor(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (rootToolCount.value === 1) resolve();
            else setImmediate(check);
          };
          check();
        }),
        "root tool execution",
      );
      await waitFor(gate.started.promise, "gated final assistant stream start");
      send("epoch steer", { deliverAs: "steer" });
      await nextMacrotask();
      expect(events).not.toContain("message_start:user:epoch steer:1");
      gate.release.resolve(undefined);
      await waitFor(steerStarted.promise, "epoch steer start");
      await waitFor(epochOneEnded.promise, "epoch one end");
      await waitFor(synchronousQueuedStarted.promise, "epoch synchronous queued start");
      await waitFor(epochTwoEnded.promise, "epoch two end");
      await waitFor(idleQueuedStarted.promise, "epoch idle queued start");
      await waitFor(epochThreeEnded.promise, "epoch three end");
      await rootPrompt;
      await waitForAgentIdle(session, "complete epoch trace");

      expectSubsequence(events, [
        "agent_start:1",
        "message_start:user:epoch root:1",
        "message_end:user::1",
        "message_start:assistant::1",
        "message_end:assistant::1",
        "message_start:toolResult::1",
        "message_end:toolResult::1",
        "message_start:assistant:gated epoch tool response:1",
        "message_end:assistant:gated epoch tool response:1",
        "message_start:user:epoch steer:1",
        "message_end:user::1",
        "message_start:assistant:gated epoch tool response:1",
        "message_end:assistant:gated epoch tool response:1",
        "agent_end:1",
      ]);
      expectSubsequence(events, [
        "agent_start:2",
        "message_start:user:epoch synchronous queued:2",
        "message_end:user::2",
        "message_start:assistant:gated epoch tool response:2",
        "message_end:assistant:gated epoch tool response:2",
        "agent_end:2",
      ]);
      expectSubsequence(events, [
        "agent_start:3",
        "message_start:user:epoch idle queued:3",
        "message_end:user::3",
        "message_start:assistant:gated epoch tool response:3",
        "message_end:assistant:gated epoch tool response:3",
        "agent_end:3",
      ]);
    } finally {
      gate.release.resolve(undefined);
      session.dispose();
    }
  });

  test("getEntries retains abandoned branches while getBranch exposes only the current leaf path", () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const root = appendUser(sessionManager, "branch root");
    const abandoned = appendAssistant(sessionManager, "abandoned branch");
    sessionManager.branch(root);
    const currentLeaf = appendUser(sessionManager, "current branch");

    expect(sessionManager.getEntries().some((entry) => entry.id === abandoned)).toBe(true);
    const branch = sessionManager.getBranch();
    expect(branch.map((entry) => entry.id)).toContain(root);
    expect(branch.map((entry) => entry.id)).toContain(currentLeaf);
    expect(branch.map((entry) => entry.id)).not.toContain(abandoned);
    expect(sessionManager.getLeafId()).toBe(currentLeaf);
  });

  test("persists each marker and message in a complete tool turn to the temporary JSONL session", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "remote-pi-sdk-contract-"));
    let session: TestSession | undefined;

    try {
      const sessionDirectory = join(temporaryRoot, "sessions");
      const sessionManager = SessionManager.create(temporaryRoot, sessionDirectory);
      const records: LifecycleRecord[] = [];
      const toolExecutionCount = { value: 0 };
      session = await createHarness({
        cwd: temporaryRoot,
        agentDir: join(temporaryRoot, "agent"),
        sessionManager,
        extensionFactories: [lifecycleExtension(records, toolExecutionCount)],
        streamFn: toolThenTextStream(),
        enableExtensionTools: true,
      });

      const sessionFile = sessionManager.getSessionFile();
      expect(sessionFile).toBeDefined();
      expect(relative(sessionDirectory, sessionFile!).startsWith("..")).toBe(false);

      await session.prompt("persist the complete local tool lifecycle");
      await nextMacrotask();

      type PersistedSessionEntry = {
        id?: string;
        parentId?: string | null;
        type?: string;
        customType?: string;
        data?: { role?: string };
        message?: {
          role?: string;
          toolName?: string;
          isError?: boolean;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      const entries = readFileSync(sessionFile!, "utf8").trim().split("\n").map(
        (line) => JSON.parse(line) as PersistedSessionEntry,
      );

      expect(records.map((record) => record.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      for (const record of records) {
        const markerIndex = entries.findIndex((entry) => entry.id === record.markerId);
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        expect(entries[markerIndex]).toMatchObject({
          id: record.markerId,
          type: "custom",
          customType: REMOTE_PI_MARKER,
          data: { role: record.role },
        });
        const target = entries[markerIndex + 1];
        expect(target).toMatchObject({ type: "message", message: { role: record.role } });
        expect(target?.parentId).toBe(record.markerId);
      }

      expect(toolExecutionCount.value).toBe(1);
      const persistedToolResults = entries.filter(
        (entry) => entry.type === "message" && entry.message?.role === "toolResult",
      );
      expect(persistedToolResults).toHaveLength(1);
      expect(persistedToolResults[0]).toMatchObject({
        message: {
          role: "toolResult",
          toolName: TEST_TOOL_NAME,
          isError: false,
          content: [{ type: "text", text: "deterministic tool result" }],
        },
      });
    } finally {
      session?.dispose();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
