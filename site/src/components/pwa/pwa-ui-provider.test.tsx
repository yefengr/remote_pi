import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Drawer, Menu, Modal, TextInput } from "@mantine/core";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderPilot(): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-ui-scope">
        <div className="pwa-root">
          <Button>Save</Button>
        <TextInput label="Pairing name" defaultValue="Office" />
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
  assert.match(html, /mantine-Button-root/);
  assert.match(html, /mantine-TextInput-input/);
  assert.match(html, /\.pwa-ui-scope\[data-mantine-color-scheme="dark"\]/);
  assert.match(html, /--mantine-color-remotePi-filled/);
});
