import assert from "node:assert/strict";
import test from "node:test";
import { getUtf8ByteLengthV2 } from "../remote-pi/protocol-v2/codec";
import { MAX_FRAME_BYTES } from "../remote-pi/protocol-v2/schema";
import type { ClientFrame } from "../remote-pi/protocol-v2/frames";
import { ImageUploadError, getImageDataCharBudget, getImageOutputMime, getJpegTranscodeSteps } from "./image-upload";

const frame: Omit<Extract<ClientFrame, { type: "user_message" }>, "images"> = {
  protocol_version: 2,
  type: "user_message",
  id: "request-id",
  channel_id: "channel-id",
  history_generation: "generation-id",
  client_request_id: "client-request-id",
  text: "describe this image",
};

test("maps supported source formats to their required output MIME", () => {
  assert.equal(getImageOutputMime("image/png"), "image/png");
  assert.equal(getImageOutputMime("image/jpeg"), "image/jpeg");
  assert.equal(getImageOutputMime("image/webp"), "image/jpeg");
  assert.throws(() => getImageOutputMime("image/gif"), (error: unknown) => error instanceof ImageUploadError && error.code === "unsupported_format");
});

test("derives the image budget from the complete user-message frame", () => {
  const expected = MAX_FRAME_BYTES - getUtf8ByteLengthV2({ ...frame, images: [{ data: "", mime: "image/jpeg" }] });
  assert.equal(getImageDataCharBudget(frame, "image/jpeg"), expected);
  assert.ok(getImageDataCharBudget({ ...frame, text: `${frame.text}${"x".repeat(100)}` }, "image/jpeg") < expected);
});

test("starts JPEG and WebP transcoding at 2048px and 85% quality", () => {
  const steps = getJpegTranscodeSteps(4096);
  assert.deepEqual(steps[0], { maxDimension: 2048, quality: 0.85 });
  assert.deepEqual(steps.at(-1), { maxDimension: 768, quality: 0.5 });
});
