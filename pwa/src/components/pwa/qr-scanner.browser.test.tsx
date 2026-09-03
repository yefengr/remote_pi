import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { QrScanner } from "./qr-scanner";
import type { IScannerControls } from "@zxing/browser";

type ScannerResult = { getText: () => string };
type ScannerError = { name: string };
type ScannerCallback = (result: ScannerResult | undefined, error: ScannerError | undefined, controls: IScannerControls) => void;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
type CameraCall = {
  constraints: MediaStreamConstraints;
  video: HTMLVideoElement | undefined;
  callback: ScannerCallback;
};
type CameraMock = {
  deferred: Deferred<IScannerControls>;
  calls: CameraCall[];
};
type ImageMock = {
  deferred: Deferred<ScannerResult>;
  urls: string[];
};
type MockReader = {
  decodeFromConstraints: ReturnType<typeof vi.fn>;
  decodeFromImageUrl: ReturnType<typeof vi.fn>;
};

const zxing = vi.hoisted(() => {
  const state: {
    camera: CameraMock | null;
    image: ImageMock | null;
    instances: MockReader[];
  } = { camera: null, image: null, instances: [] };
  const BrowserQRCodeReader = vi.fn(function MockBrowserQRCodeReader(this: MockReader) {
    this.decodeFromConstraints = vi.fn((constraints: MediaStreamConstraints, video: HTMLVideoElement | undefined, callback: ScannerCallback) => {
      state.camera?.calls.push({ constraints, video, callback });
      return state.camera?.deferred.promise ?? new Promise<IScannerControls>(() => {});
    });
    this.decodeFromImageUrl = vi.fn((url: string) => {
      state.image?.urls.push(url);
      return state.image?.deferred.promise ?? Promise.resolve({ getText: () => "unused" });
    });
    state.instances.push(this);
  });

  return { BrowserQRCodeReader, state };
});

vi.mock("@zxing/browser", () => ({ BrowserQRCodeReader: zxing.BrowserQRCodeReader }));

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function prepareCamera() {
  const camera: CameraMock = { deferred: createDeferred<IScannerControls>(), calls: [] };
  zxing.state.camera = camera;
  return camera;
}

function prepareImage() {
  const image: ImageMock = { deferred: createDeferred<ScannerResult>(), urls: [] };
  zxing.state.image = image;
  return image;
}

function createControls() {
  return { stop: vi.fn() } as IScannerControls;
}

function createResult(value: string): ScannerResult {
  return { getText: () => value };
}

function emitCameraResult(camera: CameraMock, controls: IScannerControls, result?: ScannerResult, error?: ScannerError) {
  expect(camera.calls).toHaveLength(1);
  camera.calls[0].callback(result, error, controls);
}

function QrScannerHarness({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return <>{open ? <QrScanner onScan={onScan} onClose={() => { onClose(); setOpen(false); }} /> : null}</>;
}

function UnmountableQrScanner({ onScan = vi.fn() }: { onScan?: (value: string) => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(false)}>Unmount scanner</button>
    {open ? <QrScanner onScan={onScan} onClose={vi.fn()} /> : null}
  </>;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function selectImage(input: HTMLInputElement, fileName = "qr.png") {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], fileName, { type: "image/png" })],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(async () => {
  zxing.BrowserQRCodeReader.mockClear();
  zxing.state.instances.length = 0;
  zxing.state.camera = null;
  zxing.state.image = null;
  await page.viewport(1280, 900);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

test("starts the camera with the expected video element and handles decoder errors", async () => {
  const camera = prepareCamera();
  const screen = await renderPwa(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);

  const [{ constraints, video }] = camera.calls;
  expect(constraints).toEqual({ audio: false, video: { facingMode: { ideal: "environment" } } });
  expect(video).toBeInstanceOf(HTMLVideoElement);
  expect(video?.muted).toBe(true);
  expect(video?.playsInline).toBe(true);

  const controls = createControls();
  emitCameraResult(camera, controls, undefined, { name: "NotFoundException" });
  await expect.element(screen.getByText("Could not read this QR code.")).not.toBeInTheDocument();
  emitCameraResult(camera, controls, undefined, { name: "ChecksumException" });
  await expect.element(screen.getByText("Could not read this QR code.")).toBeVisible();
});

test("camera result wins once and ignores later camera or image results", async () => {
  const camera = prepareCamera();
  const image = prepareImage();
  const onScan = vi.fn();
  await renderPwa(<QrScanner onScan={onScan} onClose={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  const controls = createControls();

  emitCameraResult(camera, controls, createResult("camera-first"));
  expect(controls.stop).toHaveBeenCalledTimes(1);
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(onScan).toHaveBeenCalledWith("camera-first");
  emitCameraResult(camera, controls, createResult("camera-later"));

  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-image");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  selectImage(input!);
  image.deferred.resolve(createResult("image-later"));
  await settle();

  expect(image.urls).toEqual(["blob:qr-image"]);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:qr-image");
  expect(onScan).toHaveBeenCalledTimes(1);
});

test("shows camera startup failure only while mounted", async () => {
  const camera = prepareCamera();
  const onScan = vi.fn();
  const screen = await renderPwa(<QrScanner onScan={onScan} onClose={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.reject(new Error("camera denied"));
  await expect.element(screen.getByText("Camera access was unavailable. Use an image instead.")).toBeVisible();
  expect(onScan).not.toHaveBeenCalled();

  const lateCamera = prepareCamera();
  const lateScreen = await renderPwa(<UnmountableQrScanner onScan={onScan} />);
  await expect.poll(() => lateCamera.calls).toHaveLength(1);
  await lateScreen.getByRole("button", { name: "Unmount scanner" }).click();
  lateCamera.deferred.reject(new Error("late camera denied"));
  await settle();
  expect(onScan).not.toHaveBeenCalled();
});

test("stops controls that resolve after the scanner unmounts", async () => {
  const camera = prepareCamera();
  const controls = createControls();
  const screen = await renderPwa(<UnmountableQrScanner />);
  await expect.poll(() => camera.calls).toHaveLength(1);

  await screen.getByRole("button", { name: "Unmount scanner" }).click();
  camera.deferred.resolve(controls);
  await expect.poll(() => controls.stop).toHaveBeenCalledTimes(1);
});

test("scans selected images, stops the camera, and always revokes their object URLs", async () => {
  const camera = prepareCamera();
  const image = prepareImage();
  const controls = createControls();
  const onScan = vi.fn();
  const screen = await renderPwa(<QrScanner onScan={onScan} onClose={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.resolve(controls);
  await settle();
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chosen-qr");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  const click = vi.spyOn(input!, "click");

  await screen.getByRole("button", { name: "Choose QR image" }).click();
  expect(click).toHaveBeenCalledTimes(1);
  selectImage(input!);
  await expect.poll(() => image.urls).toEqual(["blob:chosen-qr"]);
  image.deferred.resolve(createResult("image-first"));

  await expect.poll(() => onScan).toHaveBeenCalledWith("image-first");
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(controls.stop).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:chosen-qr");
});

test("reports image decode failures and revokes their object URLs", async () => {
  const camera = prepareCamera();
  const image = prepareImage();
  const screen = await renderPwa(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bad-qr");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  selectImage(input!, "bad.png");
  await expect.poll(() => image.urls).toEqual(["blob:bad-qr"]);
  image.deferred.reject(new Error("invalid image"));

  await expect.element(screen.getByText("No Remote Pi QR code was found in that image.")).toBeVisible();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:bad-qr");
});

test("Close scanner calls onClose and releases active camera controls through parent unmount", async () => {
  const camera = prepareCamera();
  const controls = createControls();
  const onClose = vi.fn();
  const screen = await renderPwa(<QrScannerHarness onScan={vi.fn()} onClose={onClose} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.resolve(controls);
  await settle();

  await screen.getByRole("button", { name: "Close scanner" }).click();
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(controls.stop).toHaveBeenCalledTimes(1);
});

test("keeps the scanner controls reachable in a 390 by 844 viewport", async () => {
  prepareCamera();
  await page.viewport(390, 844);
  const screen = await renderPwa(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog").element();
  const rect = dialog.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);

  for (const name of ["Close scanner", "Choose QR image"]) {
    const button = screen.getByRole("button", { name }).element();
    const buttonRect = button.getBoundingClientRect();
    expect(buttonRect.width).toBeGreaterThanOrEqual(44);
    expect(buttonRect.height).toBeGreaterThanOrEqual(44);
  }
});
