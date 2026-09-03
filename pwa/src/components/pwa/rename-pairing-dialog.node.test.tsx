import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RenamePairingDialog } from "./rename-pairing-dialog";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

const device: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "device-main",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};

test("renders the rename dialog with Mantine controls instead of a browser prompt", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><RenamePairingDialog device={device} onSave={async () => {}} onClose={() => {}} /></PwaUiProvider>);

  expect(html).toMatch(/mantine-Modal-content/);
  expect(html).toMatch(/pwa-input/);
  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/Rename pairing/);
  expect(html).toMatch(/Pairing name/);
  expect(html).toMatch(/Choose a local name for/);
  expect(html).toMatch(/This only changes the label in this browser/);
  expect(html).toMatch(/value="Pi on office"/);
  expect(html).toMatch(/>Cancel</);
  expect(html).toMatch(/>Save</);
  expect(html).not.toMatch(/Name this pairing/);
});
