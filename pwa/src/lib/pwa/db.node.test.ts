import { expect, test } from "vitest";
import { makePwaDeviceId, makePwaEndpointId } from "./db";

test("creates stable device and endpoint keys without room aliases", () => {
  const device = "ER0CaBbQVX";
  expect(makePwaDeviceId(device)).toBe(device);
  expect(makePwaEndpointId(device, "endpoint-a")).not.toBe(makePwaEndpointId(device, "endpoint-b"));
  expect(makePwaEndpointId(device, "endpoint/a")).toBe("ER0CaBbQVX:endpoint%2Fa");
});
