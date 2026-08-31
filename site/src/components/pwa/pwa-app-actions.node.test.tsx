import { expect, test } from "vitest";
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

  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/pwa-icon-button/);
  expect(html).toMatch(/class="[^"]*pwa-session-trigger[^"]*"/);
  expect(html).toMatch(/aria-label="Open endpoint switcher"/);
  expect(html).toMatch(/aria-haspopup="dialog"/);
  expect(html).toMatch(/aria-expanded="true"/);
  expect(html).toMatch(/Endpoint: Office Pi \/ interactive/);
  expect(html).toMatch(/aria-label="Refresh app"/);
  expect(html).toMatch(/title="Refresh app"/);
  expect(html).toMatch(/aria-label="Open settings"/);
  expect(html).toMatch(/title="Settings"/);
  expect(html).toMatch(/>Try again</);
  expect(html).toMatch(/>3 new output</);
  expect(html).toMatch(/role="status"/);
  expect(html).toMatch(/Relay is not connected\./);
  expect(html).toMatch(/aria-label="Dismiss"/);
});

test("renders Latest when output is unread-free", () => {
  const html = renderActions(0);

  expect(html).toMatch(/>Latest</);
  expect(html).not.toMatch(/new output/);
});

test("does not render the session trigger without a label", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><SessionSwitcherTrigger label={null} expanded={false} onOpen={() => {}} /></PwaUiProvider>);

  expect(html).not.toMatch(/pwa-session-trigger/);
  expect(html).not.toMatch(/Open session switcher/);
});

test("does not render the toast without a message", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><PwaStatusToast message={null} onDismiss={() => {}} /></PwaUiProvider>);

  expect(html).not.toMatch(/pwa-toast/);
  expect(html).not.toMatch(/Dismiss/);
});

test("does not render message actions without visible actions", () => {
  const hidden = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show={false} showRetry showLatest unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const empty = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  expect(hidden).not.toMatch(/pwa-message-actions/);
  expect(empty).not.toMatch(/pwa-message-actions/);
});

test("renders Retry and Latest independently", () => {
  const retry = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const latest = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest unreadOutput={0} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  expect(retry).toMatch(/>Try again</);
  expect(retry).not.toMatch(/>Latest</);
  expect(latest).toMatch(/>Latest</);
  expect(latest).not.toMatch(/>Try again</);
});
