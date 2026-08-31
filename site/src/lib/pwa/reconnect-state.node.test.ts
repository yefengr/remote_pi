import { expect, test } from "vitest";
import { ReconnectState } from "./reconnect-state";

test("replacement close and delayed onclose schedule at most once", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.replacementBye();
  expect(state.request("closed", (trigger) => scheduled.push(trigger))).toBe(true);
  expect(state.request("closed", (trigger) => scheduled.push(trigger))).toBe(false);
  expect(scheduled).toEqual(["closed"]);
});

test("terminal close, error, and connect rejection schedule nothing", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.terminalBye();
  for (const trigger of ["closed", "error", "connect_rejected"] as const) {
    expect(state.request(trigger, (next) => scheduled.push(next))).toBe(false);
  }
  expect(scheduled).toEqual([]);
});

test("stale connection callbacks cannot schedule for a newer connection", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  const staleToken = state.beginConnection();
  state.beginConnection();
  expect(state.request("connect_rejected", (trigger) => scheduled.push(trigger), staleToken)).toBe(false);
  expect(scheduled).toEqual([]);
});

test("user recovery clears terminal gate and permits one new schedule", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.terminalBye();
  state.userRecover();
  expect(state.request("closed", (trigger) => scheduled.push(trigger))).toBe(true);
  expect(state.request("error", (trigger) => scheduled.push(trigger))).toBe(false);
  expect(scheduled).toEqual(["closed"]);
});

test("cancel invalidates a queued callback without opening a recovery gate", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  const token = state.beginConnection();
  expect(state.request("closed", (trigger) => scheduled.push(trigger), token)).toBe(true);
  state.cancel();
  expect(state.request("error", (trigger) => scheduled.push(trigger), token)).toBe(false);
  expect(state.request("error", (trigger) => scheduled.push(trigger))).toBe(true);
  expect(scheduled).toEqual(["closed", "error"]);
});
