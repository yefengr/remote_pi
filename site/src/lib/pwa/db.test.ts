import assert from "node:assert/strict";
import test from "node:test";
import { makePwaDeviceId, makePwaEndpointId } from "./db";

test("creates stable device and endpoint keys without room aliases", () => {
  const device = "ER0CaBbQVX";
  assert.equal(makePwaDeviceId(device), device);
  assert.notEqual(makePwaEndpointId(device, "endpoint-a"), makePwaEndpointId(device, "endpoint-b"));
  assert.equal(makePwaEndpointId(device, "endpoint/a"), "ER0CaBbQVX:endpoint%2Fa");
});
