import { getUtf8ByteLengthV2 } from "../remote-pi/protocol-v2/codec";
import { MAX_FRAME_BYTES } from "../remote-pi/protocol-v2/schema";
import type { ClientFrame } from "../remote-pi/protocol-v2/frames";
import type { WireImage } from "../remote-pi/types";

type UserMessageFrame = Extract<ClientFrame, { type: "user_message" }>;
type UserMessageWithoutImages = Omit<UserMessageFrame, "images">;
type OutputImageMime = "image/png" | "image/jpeg";

type JpegTranscodeStep = {
  maxDimension: number;
  quality: number;
};

const JPEG_DIMENSIONS = [2048, 1792, 1536, 1280, 1024, 768] as const;
const JPEG_QUALITIES = [0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5] as const;

export class ImageUploadError extends Error {
  constructor(
    public readonly code: "unsupported_format" | "frame_too_large" | "image_too_large" | "transparent_png_too_large" | "decode_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImageUploadError";
  }
}

export function getImageOutputMime(sourceMime: string): OutputImageMime {
  switch (sourceMime.toLowerCase()) {
    case "image/png": return "image/png";
    case "image/jpeg":
    case "image/webp": return "image/jpeg";
    default: throw new ImageUploadError("unsupported_format", "Choose a PNG, JPEG, or WebP image.");
  }
}

/** Computes the available image-data characters from the exact outgoing frame. */
export function getImageDataCharBudget(frame: UserMessageWithoutImages, mime: OutputImageMime): number {
  const overhead = getUtf8ByteLengthV2({ ...frame, images: [{ data: "", mime }] });
  return Math.max(0, MAX_FRAME_BYTES - overhead);
}

export function getJpegTranscodeSteps(sourceMaxDimension: number): JpegTranscodeStep[] {
  const initialDimension = Math.min(2048, Math.max(1, Math.floor(sourceMaxDimension)));
  const dimensions = [
    initialDimension,
    ...JPEG_DIMENSIONS.filter((dimension) => dimension < initialDimension),
  ];
  const steps: JpegTranscodeStep[] = [];
  for (const maxDimension of dimensions) {
    for (const quality of JPEG_QUALITIES) steps.push({ maxDimension, quality });
  }
  return steps;
}

export async function prepareImageAttachment(source: Blob, frame: UserMessageWithoutImages): Promise<WireImage> {
  const sourceMime = getImageOutputMime(source.type);
  if (getImageDataCharBudget(frame, sourceMime) < 4 && sourceMime === "image/png") {
    throw new ImageUploadError("frame_too_large", "Message text is too large to send with an image.");
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new ImageUploadError("decode_failed", "This browser cannot prepare image attachments.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch (error) {
    throw new ImageUploadError("decode_failed", "Could not read that image.", { cause: error });
  }

  try {
    if (sourceMime === "image/png") {
      for (const maxDimension of getPngTranscodeDimensions(Math.max(bitmap.width, bitmap.height))) {
        const { width, height } = scaledDimensions(bitmap.width, bitmap.height, maxDimension);
        const encoded = await encodeBitmap(bitmap, width, height, "image/png");
        const data = await blobToBase64(encoded);
        if (data.length <= getImageDataCharBudget(frame, "image/png")) return { data, mime: "image/png" };
      }
      if (hasTransparency(bitmap)) {
        throw new ImageUploadError("transparent_png_too_large", "This transparent PNG is too large to send.");
      }
      throw new ImageUploadError("image_too_large", "This PNG is too large to send.");
    }

    const dataBudget = getImageDataCharBudget(frame, "image/jpeg");
    if (dataBudget < 4) {
      throw new ImageUploadError("frame_too_large", "Message text is too large to send with an image.");
    }
    for (const step of getJpegTranscodeSteps(Math.max(bitmap.width, bitmap.height))) {
      const { width, height } = scaledDimensions(bitmap.width, bitmap.height, step.maxDimension);
      const encoded = await encodeBitmap(bitmap, width, height, "image/jpeg", step.quality);
      const data = await blobToBase64(encoded);
      if (data.length <= dataBudget) return { data, mime: "image/jpeg" };
    }
    throw new ImageUploadError("image_too_large", "This image is too large to send.");
  } finally {
    bitmap.close();
  }
}

function getPngTranscodeDimensions(sourceMaxDimension: number): number[] {
  const initialDimension = Math.min(2048, Math.max(1, Math.floor(sourceMaxDimension)));
  return [initialDimension, ...JPEG_DIMENSIONS.filter((dimension) => dimension < initialDimension)];
}

function scaledDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encodeBitmap(bitmap: ImageBitmap, width: number, height: number, mime: OutputImageMime, quality?: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new ImageUploadError("decode_failed", "Could not prepare that image.");
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ImageUploadError("decode_failed", "Could not encode that image."));
    }, mime, quality);
  });
}

function hasTransparency(bitmap: ImageBitmap): boolean {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return true;
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true;
  }
  return false;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}
