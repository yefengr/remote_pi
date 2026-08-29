import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RenamePairingDialog } from "./rename-pairing-dialog";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaPeerRecord } from "@/lib/pwa/db";

const peer: PwaPeerRecord = {
  id: "peer:main",
  remoteEpk: "e5FRoCabBqVX",
  sessionName: "XCrawl#2",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
  hostname: "office",
};

test("renders the rename dialog with Mantine controls instead of a browser prompt", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><RenamePairingDialog peer={peer} onSave={async () => {}} onClose={() => {}} /></PwaUiProvider>);

  assert.match(html, /mantine-Modal-content/);
  assert.match(html, /pwa-input/);
  assert.match(html, /pwa-button/);
  assert.match(html, /Rename pairing/);
  assert.match(html, /Pairing name/);
  assert.match(html, /Choose a local name for/);
  assert.match(html, /This only changes the label in this browser/);
  assert.match(html, /value="Pi on office"/);
  assert.match(html, />Cancel</);
  assert.match(html, />Save</);
  assert.doesNotMatch(html, /Name this pairing/);
});
