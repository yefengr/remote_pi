import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPanel } from "./settings-panel";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderSettings(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-ui-scope">
        <div className="pwa-root">
      <SettingsPanel
        withinPortal={false}
        relayUrl="https://relay.example.test"
        defaultRelayUrl="https://relay.default.test"
        onSave={async () => {}}
        onClose={() => {}}
        onClearData={async () => {}}
        onResetLayout={() => {}}
      />
        </div>
      </div>
    </PwaUiProvider>,
  );
}

test("renders settings in a Mantine drawer with relay and data actions", () => {
  const html = renderSettings();

  assert.match(html, /mantine-Drawer-content/);
  assert.match(html, /Settings/);
  assert.match(html, /Relay URL/);
  assert.match(html, /value="https:\/\/relay\.example\.test"/);
  assert.match(html, /Save settings/);
  assert.match(html, /Clear local data/);
  assert.match(html, /Reset layout/);
  assert.match(html, /mantine-TextInput-input/);
  assert.match(html, /mantine-Button-root/);
  assert.match(html, /aria-label="Close settings"/);
  assert.doesNotMatch(html, /<aside/);
  assert.doesNotMatch(html, /class="pwa-settings /);
});
