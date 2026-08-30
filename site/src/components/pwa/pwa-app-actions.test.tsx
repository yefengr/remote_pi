import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTopbarActions, PwaMessageActions, PwaStatusToast, SessionSwitcherTrigger } from "./pwa-app-actions";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderActions(unreadOutput = 3): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-root">
        <SessionSwitcherTrigger label="Endpoint: Office Pi / interactive" expanded onOpen={() => {}} />
        <DesktopTopbarActions onRefresh={() => {}} onToggleSettings={() => {}} />
        <PwaMessageActions show showRetry showLatest unreadOutput={unreadOutput} onRetry={() => {}} onLatest={() => {}} />
        <PwaStatusToast message="Relay is not connected." onDismiss={() => {}} />
      </div>
    </PwaUiProvider>,
  );
}

test("renders Mantine actions with the preserved endpoint, desktop, message, and toast semantics", () => {
  const html = renderActions();

  assert.match(html, /pwa-button/);
  assert.match(html, /pwa-icon-button/);
  assert.match(html, /class="[^"]*pwa-session-trigger[^"]*"/);
  assert.match(html, /aria-label="Open endpoint switcher"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Endpoint: Office Pi \/ interactive/);
  assert.match(html, /aria-label="Refresh app"/);
  assert.match(html, /title="Refresh app"/);
  assert.match(html, /aria-label="Open settings"/);
  assert.match(html, /title="Settings"/);
  assert.match(html, />Try again</);
  assert.match(html, />3 new output</);
  assert.match(html, /role="status"/);
  assert.match(html, /Relay is not connected\./);
  assert.match(html, /aria-label="Dismiss"/);
});

test("renders Latest when output is unread-free", () => {
  const html = renderActions(0);

  assert.match(html, />Latest</);
  assert.doesNotMatch(html, /new output/);
});

test("does not render the session trigger without a label", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><SessionSwitcherTrigger label={null} expanded={false} onOpen={() => {}} /></PwaUiProvider>);

  assert.doesNotMatch(html, /pwa-session-trigger/);
  assert.doesNotMatch(html, /Open session switcher/);
});

test("does not render the toast without a message", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><PwaStatusToast message={null} onDismiss={() => {}} /></PwaUiProvider>);

  assert.doesNotMatch(html, /pwa-toast/);
  assert.doesNotMatch(html, /Dismiss/);
});

test("does not render message actions without visible actions", () => {
  const hidden = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show={false} showRetry showLatest unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const empty = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  assert.doesNotMatch(hidden, /pwa-message-actions/);
  assert.doesNotMatch(empty, /pwa-message-actions/);
});

test("renders Retry and Latest independently", () => {
  const retry = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const latest = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest unreadOutput={0} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  assert.match(retry, />Try again</);
  assert.doesNotMatch(retry, />Latest</);
  assert.match(latest, />Latest</);
  assert.doesNotMatch(latest, />Try again</);
});
