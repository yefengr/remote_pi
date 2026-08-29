import assert from "node:assert/strict";
import test from "node:test";
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
        <Select id="room-id" label="Session" value="main" disabled data={[{ value: "main", label: "main" }, { value: "old", label: "Old workspace" }]} onChange={() => {}} defaultDropdownOpened comboboxProps={{ withinPortal: false }} />
        <Badge>ONLINE</Badge>
        <Drawer opened title="Sessions" withinPortal={false} onClose={() => {}}>
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

  assert.match(html, /Save/);
  assert.match(html, /Pairing name/);
  assert.match(html, /Sessions/);
  assert.match(html, /Rename pairing/);
  assert.match(html, /Settings/);
  assert.match(html, /pwa-button/);
  assert.match(html, /pwa-input/);
  assert.match(html, /pwa-select/);
  assert.match(html, /id="room-id"/);
  assert.match(html, /value="main"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Old workspace/);
  assert.match(html, /pwa-badge/);
  assert.match(html, /data-tone="primary"/);
  assert.match(html, /\.pwa-ui-scope\[data-mantine-color-scheme="dark"\]/);
  assert.match(html, /--mantine-color-remotePi-filled/);
});
