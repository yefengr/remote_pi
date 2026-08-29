import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PairingDialog, StartupErrorView } from "./pwa-startup";
import { PwaUiProvider } from "./pwa-ui-provider";

test("renders the startup error with a Mantine reload action", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <StartupErrorView
        error={{ title: "Local workspace is busy", message: "Close the other tab.", action: "Reload the app" }}
        onRetry={() => {}}
      />
    </PwaUiProvider>,
  );
  const reloadButton = html.match(/<button\b[^>]*>(?:(?!<\/button>).)*Reload(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";

  assert.match(html, /Local workspace is busy/);
  assert.match(html, /Close the other tab\./);
  assert.match(html, /Reload the app/);
  assert.match(reloadButton, /pwa-button/);
  assert.match(reloadButton, /data-tone="primary"/);
  assert.match(reloadButton, /type="button"/);
  assert.match(reloadButton, /data-position="left"/);
});

test("manual pairing retains a secure Mantine textarea and disabled pasted-code action", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <PairingDialog onScan={() => {}} onClose={() => {}} />
    </PwaUiProvider>,
  );

  assert.match(html, /pwa-textarea/);
  assert.match(html, /aria-label="Pairing code"/);
  assert.match(html, /rows="3"/);
  assert.match(html, /autoCapitalize="none"/);
  assert.match(html, /autoCorrect="off"/);
  assert.match(html, /spellCheck="false"/);
  assert.match(html, /pwa-button/);
  assert.match(html, /Use pasted code/);
  assert.match(html, /disabled=""/);
});
