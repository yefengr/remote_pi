import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaUiProvider } from "./pwa-ui-provider";
import { QrScanner } from "./qr-scanner";

function renderScanner(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <QrScanner onScan={() => {}} onClose={() => {}} />
    </PwaUiProvider>,
  );
}

test("renders the QR scanner with Mantine controls", () => {
  const html = renderScanner();
  const closeButton = html.match(/<button[^>]*aria-label="Close scanner"[^>]*>/)?.[0] ?? "";
  const chooseButton = html.match(/<button[^>]*>.*?Choose QR image.*?<\/button>/)?.[0] ?? "";

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Scan pairing QR code"/);
  assert.match(closeButton, /pwa-icon-button/);
  assert.match(closeButton, /pwa-icon-button/);
  assert.match(closeButton, /aria-label="Close scanner"/);
  assert.match(closeButton, /title="Close scanner"/);
  assert.match(chooseButton, /pwa-button/);
  assert.match(chooseButton, /data-tone="secondary"/);
  assert.match(html, /Choose QR image/);
  assert.match(html, /type="file"/);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /<video[^>]*muted=""[^>]*playsInline=""/);
  assert.match(html, /Hold the QR inside the frame\. Camera access stays on this page\./);
});
