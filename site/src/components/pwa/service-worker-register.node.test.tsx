import { expect, test } from "vitest";
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
  expect(match, `expected a button labelled ${label}`).toBeTruthy();
  return match![0];
}

function dismissButton(html: string): string {
  const match = html.match(/<button\b(?=[^>]*aria-label="Dismiss PWA notice")[^>]*>(?:(?!<\/button>).)*<\/button>/);
  expect(match, "expected a PWA notice dismiss button").toBeTruthy();
  return match![0];
}

test("renders the install notice with Mantine actions and preserved semantics", () => {
  const html = renderNotice({ installPrompt: true });
  const install = buttonForLabel(html, "Install app");
  const dismiss = dismissButton(html);

  expect(html).toMatch(/role="status"/);
  expect(html).toMatch(/Install Remote Pi/);
  expect(install).toMatch(/pwa-button/);
  expect(install).toMatch(/data-tone="secondary"/);
  expect(install).toMatch(/type="button"/);
  expect(dismiss).toMatch(/pwa-icon-button/);
  expect(dismiss).toMatch(/title="Dismiss"/);
});

test("renders the update notice and disables Updating after requesting an update", () => {
  const ready = renderNotice({ updateReady: true });
  const requested = renderNotice({ updateReady: true, updateRequested: true });
  const refresh = buttonForLabel(ready, "Refresh");
  const updating = buttonForLabel(requested, "Updating");

  expect(ready).toMatch(/Remote Pi update ready/);
  expect(refresh).toMatch(/pwa-button/);
  expect(refresh).toMatch(/data-tone="primary"/);
  expect(refresh).toMatch(/type="button"/);
  expect(updating).toMatch(/disabled|data-disabled/);
});

test("renders only the dismiss action for unsupported offline mode", () => {
  const html = renderNotice({ unsupported: true });
  const dismiss = dismissButton(html);

  expect(html).toMatch(/Offline app mode unavailable/);
  expect(dismiss).toMatch(/pwa-icon-button/);
  expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>).)*Install app(?:(?!<\/button>).)*<\/button>/);
  expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>).)*Refresh(?:(?!<\/button>).)*<\/button>/);
});

test("keeps install and update actions independent when both are available", () => {
  const html = renderNotice({ installPrompt: true, updateReady: true });

  expect(buttonForLabel(html, "Install app")).toMatch(/data-tone="secondary"/);
  expect(buttonForLabel(html, "Refresh")).toMatch(/data-tone="primary"/);
});
