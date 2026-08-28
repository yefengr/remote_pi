import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileTopbarMenu } from "./mobile-topbar-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderMenu(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <MobileTopbarMenu onRefresh={() => {}} onOpenSettings={() => {}} />
    </PwaUiProvider>,
  );
}

test("renders a Mantine menu trigger with refresh and settings actions", () => {
  const html = renderMenu();

  assert.match(html, /mantine-ActionIcon-root/);
  assert.match(html, /aria-label="More options"/);
  assert.match(html, /title="More options"/);
  assert.match(html, /Refresh app/);
  assert.match(html, /Settings/);
  assert.match(html, /role="menuitem"/);
});
