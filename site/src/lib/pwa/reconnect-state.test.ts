import assert from "node:assert/strict";
import test from "node:test";
import { ReconnectState } from "./reconnect-state";

test("replacement close and delayed onclose schedule at most once", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.replacementBye();
  assert.equal(state.request("closed", (trigger) => scheduled.push(trigger)), true);
  assert.equal(state.request("closed", (trigger) => scheduled.push(trigger)), false);
  assert.deepEqual(scheduled, ["closed"]);
});

test("terminal close, error, and connect rejection schedule nothing", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.terminalBye();
  for (const trigger of ["closed", "error", "connect_rejected"] as const) {
    assert.equal(state.request(trigger, (next) => scheduled.push(next)), false);
  }
  assert.deepEqual(scheduled, []);
});

test("stale connection callbacks cannot schedule for a newer connection", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  const staleToken = state.beginConnection();
  state.beginConnection();
  assert.equal(state.request("connect_rejected", (trigger) => scheduled.push(trigger), staleToken), false);
  assert.deepEqual(scheduled, []);
});

test("user recovery clears terminal gate and permits one new schedule", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  state.terminalBye();
  state.userRecover();
  assert.equal(state.request("closed", (trigger) => scheduled.push(trigger)), true);
  assert.equal(state.request("error", (trigger) => scheduled.push(trigger)), false);
  assert.deepEqual(scheduled, ["closed"]);
});

test("cancel invalidates a queued callback without opening a recovery gate", () => {
  const state = new ReconnectState();
  const scheduled: string[] = [];
  const token = state.beginConnection();
  assert.equal(state.request("closed", (trigger) => scheduled.push(trigger), token), true);
  state.cancel();
  assert.equal(state.request("error", (trigger) => scheduled.push(trigger), token), false);
  assert.equal(state.request("error", (trigger) => scheduled.push(trigger)), true);
  assert.deepEqual(scheduled, ["closed", "error"]);
});
