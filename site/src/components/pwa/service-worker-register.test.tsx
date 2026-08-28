import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceWorkerNotice } from "./service-worker-register";
import { PwaUiProvider } from "./pwa-ui-provider";

type NoticeOverrides = Partial<React.ComponentProps<typeof ServiceWorkerNotice>>;

function renderNotice(overrides: NoticeOverrides = {}): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <ServiceWorkerNotice
        installPrompt={false}
        updateReady={false}
        unsupported={false}
        updateRequested={false}
        onInstall={() => {}}
        onUpdate={() => {}}
        onDismiss={() => {}}
        {...overrides}
      />
    </PwaUiProvider>,
  );
}

function buttonForLabel(html: string, label: string): string {
  const match = html.match(new RegExp(`<button\\b[^>]*>(?:(?!<\\/button>).)*${label}(?:(?!<\\/button>).)*<\\/button>`));
  assert.ok(match, `expected a button labelled ${label}`);
  return match[0];
}

function dismissButton(html: string): string {
  const match = html.match(/<button\b(?=[^>]*aria-label="Dismiss PWA notice")[^>]*>(?:(?!<\/button>).)*<\/button>/);
  assert.ok(match, "expected a PWA notice dismiss button");
  return match[0];
}

test("renders the install notice with Mantine actions and preserved semantics", () => {
  const html = renderNotice({ installPrompt: true });
  const install = buttonForLabel(html, "Install app");
  const dismiss = dismissButton(html);

  assert.match(html, /role="status"/);
  assert.match(html, /Install Remote Pi/);
  assert.match(install, /mantine-Button-root/);
  assert.match(install, /pwa-secondary-button/);
  assert.match(install, /type="button"/);
  assert.match(dismiss, /mantine-ActionIcon-root/);
  assert.match(dismiss, /pwa-icon-button/);
  assert.match(dismiss, /title="Dismiss"/);
});

test("renders the update notice and disables Updating after requesting an update", () => {
  const ready = renderNotice({ updateReady: true });
  const requested = renderNotice({ updateReady: true, updateRequested: true });
  const refresh = buttonForLabel(ready, "Refresh");
  const updating = buttonForLabel(requested, "Updating");

  assert.match(ready, /Remote Pi update ready/);
  assert.match(refresh, /mantine-Button-root/);
  assert.match(refresh, /pwa-primary-button/);
  assert.match(refresh, /type="button"/);
  assert.match(updating, /disabled|data-disabled/);
});

test("renders only the dismiss action for unsupported offline mode", () => {
  const html = renderNotice({ unsupported: true });
  const dismiss = dismissButton(html);

  assert.match(html, /Offline app mode unavailable/);
  assert.match(dismiss, /mantine-ActionIcon-root/);
  assert.match(dismiss, /pwa-icon-button/);
  assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>).)*Install app(?:(?!<\/button>).)*<\/button>/);
  assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>).)*Refresh(?:(?!<\/button>).)*<\/button>/);
});

test("keeps install and update actions independent when both are available", () => {
  const html = renderNotice({ installPrompt: true, updateReady: true });

  assert.match(buttonForLabel(html, "Install app"), /pwa-secondary-button/);
  assert.match(buttonForLabel(html, "Refresh"), /pwa-primary-button/);
});
