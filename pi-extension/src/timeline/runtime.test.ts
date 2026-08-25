import { describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TimelineRuntime, TIMELINE_MARKER, type Correlation } from "./runtime.js";

function userMessage(text: string, timestamp = 1): Record<string, unknown> {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp = 2): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  };
}

function toolMessage(isError = false): Record<string, unknown> {
  return {
    role: "toolResult",
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
    toolCallId: "tool-1",
    toolName: "read",
    isError,
    timestamp: 3,
  };
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function markerEntries(session: SessionManager): Array<Record<string, unknown>> {
  return session.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === TIMELINE_MARKER)
    .map((entry) => entry.data as Record<string, unknown>);
}

describe("TimelineRuntime", () => {
  test("binds ALS correlation to the message object and publishes a committed user event after persistence", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const started: unknown[] = [];
    const committed: unknown[] = [];
    const runtime = new TimelineRuntime({
      getHistoryGeneration: () => "generation-1",
      onStarted: (value) => started.push(value),
      onPublished: (event, correlation) => committed.push({ event, correlation }),
    });
    runtime.attach(session);
    runtime.onAgentStart();
    const message = userMessage("hello");
    const correlation: Correlation = {
      clientRequestId: "request-1",
      origin: "pwa",
      delivery: "normal",
      senderRef: "owner-1",
    };

    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(message, session));
    expect(runtime.getCorrelation(message)).toEqual(correlation);
    const [marker] = markerEntries(session);
    expect(marker).toMatchObject({
      version: 2,
      kind: "user",
      origin: "pwa",
      delivery: "normal",
      sender_ref: "owner-1",
    });
    expect(marker).not.toHaveProperty("client_request_id");
    expect(started).toEqual([
      expect.objectContaining({
        eventId: marker.event_id,
        groupId: marker.group_id,
        role: "user",
        correlation,
        blocks: [{ type: "text", text: "hello" }],
      }),
    ]);

    runtime.onMessageEnd(message, session);
    expect(runtime.getPublishedEvents()).toHaveLength(0);
    session.appendMessage(message as never);
    await nextMacrotask();

    const [event] = runtime.getPublishedEvents();
    expect(event).toMatchObject({
      kind: "user",
      event_id: marker.event_id,
      message_id: marker.event_id,
      origin: "pwa",
      delivery: "normal",
      sender_ref: "owner-1",
      status: "committed",
      history_generation: "generation-1",
    });
    expect(committed).toEqual([{ event, correlation }]);
  });

  test("marks steer as unknown and preserves the same run group", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.onAgentStart();
    const first = userMessage("first");
    const steer = userMessage("steer");
    const correlation: Correlation = { origin: "unknown", delivery: "unknown" };

    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(first, session));
    runtime.onMessageEnd(first, session);
    session.appendMessage(first as never);
    await nextMacrotask();
    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(steer, session));
    runtime.onMessageEnd(steer, session);
    session.appendMessage(steer as never);
    await nextMacrotask();
    const markers = markerEntries(session);
    expect(markers).toHaveLength(2);
    expect(markers[0]?.group_id).toBe(markers[1]?.group_id);
    expect(markers[0]).toMatchObject({ origin: "unknown", delivery: "unknown" });
    expect(runtime.getPublishedEvents().map((event) => event.kind)).toEqual(["user", "user"]);
  });

  test("maps assistant, provider errors, and tool messages into immutable formal events", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.onAgentStart();
    const assistant = assistantMessage("answer");
    const providerError = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider failed",
      timestamp: 3,
    };
    const tool = toolMessage();
    runtime.onMessageStart(assistant, session);
    runtime.onMessageEnd(assistant, session);
    session.appendMessage(assistant as never);
    await nextMacrotask();
    runtime.onMessageStart(providerError, session);
    runtime.onMessageEnd(providerError, session);
    session.appendMessage(providerError as never);
    await nextMacrotask();
    runtime.onMessageStart(tool, session);
    runtime.onMessageEnd(tool, session);
    session.appendMessage(tool as never);
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", status: "complete" }),
      expect.objectContaining({ kind: "provider_error", message: "provider failed" }),
      expect.objectContaining({ kind: "tool", status: "complete", result: expect.anything() }),
    ]));
  });

  test("stops scanner at markers, hard boundaries, and role mismatch", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const first = userMessage("first");
    runtime.onAgentStart();
    runtime.onMessageStart(first, session);
    const firstMarker = markerEntries(session)[0];
    session.appendCustomEntry("remote-pi:other", { ignored: true });
    session.appendCustomEntry(TIMELINE_MARKER, {
      version: 2,
      event_id: "other-event",
      group_id: "other-group",
      kind: "user",
      origin: "unknown",
      delivery: "unknown",
    });
    session.appendMessage(first as never);

    const recovered = runtime.recover(session);
    expect(recovered).toHaveLength(2);
    const recoveredUser = recovered.find((event) => event.kind === "user");
    expect(recoveredUser?.event_id).toBe("other-event");
    expect(firstMarker?.event_id).not.toBe(recoveredUser?.event_id);
    expect(recovered).toContainEqual(expect.objectContaining({
      kind: "custom",
      payload: { custom_type: "remote-pi:other", data: { ignored: true } },
    }));
  });

  test("recovers compaction and metadata custom entries and publishes branch summaries", () => {
    const session = SessionManager.inMemory(process.cwd());
    const firstKeptEntryId = session.appendMessage(userMessage("kept") as never);
    const compactionId = session.appendCompaction(
      "summary",
      firstKeptEntryId,
      123,
      { source: "test" },
      true,
    );
    const customId = session.appendCustomEntry("third-party:metadata", { value: 1 });
    const runtime = new TimelineRuntime({ getHistoryGeneration: () => "generation-system" });

    expect(runtime.recover(session)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_id: compactionId,
        kind: "compaction",
        history_generation: "generation-system",
        payload: expect.objectContaining({ summary: "summary", tokens_before: 123 }),
      }),
      expect.objectContaining({
        event_id: customId,
        kind: "custom",
        payload: { custom_type: "third-party:metadata", data: { value: 1 } },
      }),
    ]));

    const branchSummary = runtime.publishSessionEntry({
      type: "branch_summary",
      id: "branch-summary-id",
      parentId: session.getLeafId(),
      timestamp: new Date().toISOString(),
      fromId: firstKeptEntryId,
      summary: "branch summary",
      details: { files: 2 },
      fromHook: false,
    }, session);
    expect(branchSummary).toMatchObject({
      event_id: "branch-summary-id",
      kind: "branch_summary",
      payload: expect.objectContaining({ summary: "branch summary", from_id: firstKeptEntryId }),
    });
  });

  test("recovers an unmatched branch message with a legacy id and does not guess a group root", () => {
    const session = SessionManager.inMemory(process.cwd());
    const messageId = session.appendMessage(userMessage("legacy") as never);
    const runtime = new TimelineRuntime();
    const [event] = runtime.recover(session);
    expect(event).toMatchObject({
      event_id: `legacy:${messageId}`,
      message_id: `legacy:${messageId}`,
      origin: "unknown",
      delivery: "unknown",
      group_id: `legacy:${session.getSessionId()}`,
    });
  });
});
