import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PairingDialog } from "./pwa-startup";
import { PwaUiProvider } from "./pwa-ui-provider";

test("manual pairing retains a secure Mantine textarea and disabled pasted-code action", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <PairingDialog onScan={() => {}} onClose={() => {}} />
    </PwaUiProvider>,
  );

  assert.match(html, /mantine-Textarea-input/);
  assert.match(html, /aria-label="Pairing code"/);
  assert.match(html, /rows="3"/);
  assert.match(html, /autoCapitalize="none"/);
  assert.match(html, /autoCorrect="off"/);
  assert.match(html, /spellCheck="false"/);
  assert.match(html, /mantine-Button-root/);
  assert.match(html, /Use pasted code/);
  assert.match(html, /disabled=""/);
});
