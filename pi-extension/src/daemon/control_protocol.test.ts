import { describe, expect, test } from "vitest";
import { encodeReply, encodeRequest, parseReply, parseRequest, type ControlRequest } from "./control_protocol.js";

describe("control protocol", () => {
  test("frames requests and replies as newline-delimited JSON", () => {
    expect(encodeRequest({ op: "list" })).toBe('{"op":"list"}\n');
    expect(parseReply(encodeReply({ ok: true, data: { daemons: [] } }).trim())).toEqual({ ok: true, data: { daemons: [] } });
  });

  test("round-trips the v2 lifecycle and wake-free cron operations", () => {
    const requests: ControlRequest[] = [
      { op: "start", id: "daemon-id" },
      { op: "stop", id: "daemon-id" },
      { op: "send", id: "daemon-id", text: "hello" },
      { op: "cron_add", daemon_id: "daemon-id", schedule: "0 9 * * *", prompt: "hi", catchup: true },
    ];
    for (const request of requests) expect(parseRequest(encodeRequest(request).trim())).toEqual(request);
  });

  test("cron_add schema has no wake escape hatch", () => {
    const request: Extract<ControlRequest, { op: "cron_add" }> = { op: "cron_add", daemon_id: "d", schedule: "* * * * *", prompt: "p" };
    expect("wake" in request).toBe(false);
  });

  test("rejects malformed frames", () => {
    expect(() => parseRequest("{bad")).toThrow(/malformed/i);
    expect(() => parseRequest("null")).toThrow(/object/i);
    expect(() => parseRequest('{"x":1}')).toThrow(/op/i);
    expect(() => parseReply('{"data":{}}')).toThrow(/ok/i);
  });
});
