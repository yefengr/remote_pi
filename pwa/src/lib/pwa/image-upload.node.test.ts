import { expect, test } from "vitest";
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
  expect(getImageOutputMime("image/png")).toBe("image/png");
  expect(getImageOutputMime("image/jpeg")).toBe("image/jpeg");
  expect(getImageOutputMime("image/webp")).toBe("image/jpeg");

  let caught: unknown;
  try {
    getImageOutputMime("image/gif");
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ImageUploadError);
  expect((caught as ImageUploadError).code).toBe("unsupported_format");
});

test("derives the image budget from the complete user-message frame", () => {
  const expected = MAX_FRAME_BYTES - getUtf8ByteLengthV2({ ...frame, images: [{ data: "", mime: "image/jpeg" }] });
  expect(getImageDataCharBudget(frame, "image/jpeg")).toBe(expected);
  expect(getImageDataCharBudget({ ...frame, text: `${frame.text}${"x".repeat(100)}` }, "image/jpeg")).toBeLessThan(expected);
});

test("starts JPEG and WebP transcoding at 2048px and 85% quality", () => {
  const steps = getJpegTranscodeSteps(4096);
  expect(steps[0]).toEqual({ maxDimension: 2048, quality: 0.85 });
  expect(steps.at(-1)).toEqual({ maxDimension: 768, quality: 0.5 });
});
