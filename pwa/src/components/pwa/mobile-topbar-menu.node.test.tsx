import { expect, test } from "vitest";
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

test("renders a closed Mantine menu trigger without its actions", () => {
  const html = renderMenu();

  expect(html).toMatch(/pwa-icon-button/);
  expect(html).toMatch(/aria-label="More options"/);
  expect(html).toMatch(/title="More options"/);
  expect(html).toMatch(/aria-haspopup="menu"/);
  expect(html).toMatch(/aria-expanded="false"/);
  expect(html).not.toMatch(/Refresh app/);
  expect(html).not.toMatch(/Settings/);
  expect(html).not.toMatch(/role="menuitem"/);
});
