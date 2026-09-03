import { expect, test } from "vitest";
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

  expect(html).toMatch(/role="dialog"/);
  expect(html).toMatch(/aria-modal="true"/);
  expect(html).toMatch(/aria-label="Scan pairing QR code"/);
  expect(closeButton).toMatch(/pwa-icon-button/);
  expect(closeButton).toMatch(/pwa-icon-button/);
  expect(closeButton).toMatch(/aria-label="Close scanner"/);
  expect(closeButton).toMatch(/title="Close scanner"/);
  expect(chooseButton).toMatch(/pwa-button/);
  expect(chooseButton).toMatch(/data-tone="secondary"/);
  expect(html).toMatch(/Choose QR image/);
  expect(html).toMatch(/type="file"/);
  expect(html).toMatch(/accept="image\/\*"/);
  expect(html).toMatch(/<video[^>]*muted=""[^>]*playsInline=""/);
  expect(html).toMatch(/Hold the QR inside the frame\. Camera access stays on this page\./);
});
