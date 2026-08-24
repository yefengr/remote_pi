import { describe, expect, test } from "vitest";
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

function isMarker(entry: BranchEntry | undefined): entry is MarkerEntry {
  return entry?.type === "custom" && entry.customType === REMOTE_PI_MARKER;
}

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
function scanTargetAfterMarker(
  entries: readonly BranchEntry[],
  markerIndex: number,
  targetRole: "user" | "assistant" | "toolResult",
): BranchEntry | undefined {
  for (let index = markerIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isMarker(entry)) return undefined;

    switch (entry.type) {
      case "custom":
      case "custom_message":
      case "thinking_level_change":
      case "model_change":
      case "label":
      case "session_info":
      case "compaction":
      case "branch_summary":
        continue;
      case "message":
        return entry.message.role === targetRole ? entry : undefined;
      default:
        return undefined;
    }
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

  test("scanner rejects hard boundaries and defensively skips legal non-target entries", () => {
    const nextMarkerManager = SessionManager.inMemory(process.cwd());
    const firstMarker = nextMarkerManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    const secondMarker = nextMarkerManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    const secondTarget = appendUser(nextMarkerManager, "target after second marker");
    const nextMarkerBranch = nextMarkerManager.getBranch();
    expect(scanTargetAfterMarker(nextMarkerBranch, nextMarkerBranch.findIndex((entry) => entry.id === firstMarker), "user")).toBeUndefined();
    expect(scanTargetAfterMarker(nextMarkerBranch, nextMarkerBranch.findIndex((entry) => entry.id === secondMarker), "user")?.id).toBe(secondTarget);

    const incompatibleManager = SessionManager.inMemory(process.cwd());
    const incompatibleMarker = incompatibleManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    appendAssistant(incompatibleManager, "incompatible assistant");
    const incompatibleBranch = incompatibleManager.getBranch();
    expect(scanTargetAfterMarker(incompatibleBranch, incompatibleBranch.findIndex((entry) => entry.id === incompatibleMarker), "user")).toBeUndefined();

    // Runtime message_start handlers currently queue custom_message through steer, so it cannot
    // occupy this window. Keep scanner recovery conservative for legacy or abnormal topologies.
    const legalManager = SessionManager.inMemory(process.cwd());
    const legalMarker = legalManager.appendCustomEntry(REMOTE_PI_MARKER, { expectedRole: "user" });
    legalManager.appendCustomEntry("third-party:metadata", { visible: false });
    legalManager.appendCustomMessageEntry("third-party:context", "legal context", false);
    legalManager.appendThinkingLevelChange("low");
    const legalTarget = appendUser(legalManager, "target after legal entries");
    const legalBranch = legalManager.getBranch();
    expect(scanTargetAfterMarker(legalBranch, legalBranch.findIndex((entry) => entry.id === legalMarker), "user")?.id).toBe(legalTarget);
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
