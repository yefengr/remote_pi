import { expect, test } from "vitest";
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

  expect(html).toMatch(/mantine-Drawer-content/);
  expect(html).toMatch(/Settings/);
  expect(html).toMatch(/Relay URL/);
  expect(html).toMatch(/value="https:\/\/relay\.example\.test"/);
  expect(html).toMatch(/Save settings/);
  expect(html).toMatch(/Clear local data/);
  expect(html).toMatch(/Reset layout/);
  expect(html).toMatch(/pwa-input/);
  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/aria-label="Close settings"/);
  expect(html).not.toMatch(/<aside/);
  expect(html).not.toMatch(/class="pwa-settings /);
});
