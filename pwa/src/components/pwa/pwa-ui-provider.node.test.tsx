import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Drawer, Menu, Modal } from "@mantine/core";
import { Badge, Button, Input, Select } from "@/components/ui";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderPilot(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-ui-scope">
        <div className="pwa-root">
          <Button>Save</Button>
        <Input label="Pairing name" defaultValue="Office" />
        <Select id="endpoint-id" label="Endpoint" value="endpoint-main" disabled data={[{ value: "endpoint-main", label: "endpoint-main" }, { value: "endpoint-old", label: "Old endpoint" }]} onChange={() => {}} defaultDropdownOpened comboboxProps={{ withinPortal: false }} />
        <Badge>ONLINE</Badge>
        <Drawer opened title="Endpoints" withinPortal={false} onClose={() => {}}>
          Session content
        </Drawer>
        <Modal opened title="Rename pairing" withinPortal={false} onClose={() => {}}>
          Rename content
        </Modal>
        <Menu opened withinPortal={false}>
          <Menu.Target><Button>More</Button></Menu.Target>
          <Menu.Dropdown><Menu.Item>Settings</Menu.Item></Menu.Dropdown>
        </Menu>
        </div>
      </div>
    </PwaUiProvider>,
  );
}

test("Mantine PWA pilot renders core controls with the Remote Pi provider", () => {
  const html = renderPilot();

  expect(html).toMatch(/Save/);
  expect(html).toMatch(/Pairing name/);
  expect(html).toMatch(/Endpoints/);
  expect(html).toMatch(/Rename pairing/);
  expect(html).toMatch(/Settings/);
  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/pwa-input/);
  expect(html).toMatch(/pwa-select/);
  expect(html).toMatch(/id="endpoint-id"/);
  expect(html).toMatch(/value="endpoint-main"/);
  expect(html).toMatch(/disabled=""/);
  expect(html).toMatch(/Old endpoint/);
  expect(html).toMatch(/pwa-badge/);
  expect(html).toMatch(/data-tone="primary"/);
  expect(html).toMatch(/\.pwa-ui-scope\[data-mantine-color-scheme="dark"\]/);
  expect(html).toMatch(/--mantine-color-remotePi-filled/);
});
