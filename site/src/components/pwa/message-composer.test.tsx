import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageComposer } from "./message-composer";

const commonProps = {
  attachment: null,
  canAttachImage: true,
  sendingImage: false,
  isOnline: true,
  stopping: false,
  onDraftChange: () => {},
  onSend: () => {},
  onStop: () => {},
  onSetAttachment: () => {},
  onClearAttachment: () => {},
  commandModels: [],
  commandCurrentModel: null,
  commandThinking: "off" as const,
  commandPendingAction: null,
  onNewSession: () => {},
  onCompactSession: () => {},
  onSetModel: () => {},
  onSetThinking: () => {},
  onCommandsOpen: () => {},
};

test("renders the Pi commands trigger without changing the draft", () => {
  const html = renderToStaticMarkup(<MessageComposer {...commonProps} isOnline draft="" isWorking={false} />);
  const trigger = html.match(/<button[^>]*aria-label="Pi commands"[^>]*>/)?.[0] ?? "";

  assert.match(trigger, /title="Pi commands"/);
  assert.doesNotMatch(html, /value="\/"/);
});

test("disables the Pi commands trigger while offline", () => {
  const html = renderToStaticMarkup(<MessageComposer {...commonProps} isOnline={false} draft="" isWorking={false} />);
  const trigger = html.match(/<button[^>]*aria-label="Pi commands"[^>]*>/)?.[0] ?? "";

  assert.match(trigger, /disabled=""/);
});

test("shows Stop as the only primary action while working with an empty draft", () => {
  const html = renderToStaticMarkup(<MessageComposer {...commonProps} isWorking draft="" />);

  assert.match(html, /aria-label="Stop current task"/);
  assert.doesNotMatch(html, /aria-label="Send message"/);
});

test("keeps Send available beside Stop when a draft exists", () => {
  const html = renderToStaticMarkup(<MessageComposer {...commonProps} isWorking draft="continue after this" />);

  assert.match(html, /aria-label="Stop current task"/);
  assert.match(html, /aria-label="Send message"/);
});

test("shows the pending stop state without exposing another Stop action", () => {
  const html = renderToStaticMarkup(<MessageComposer {...commonProps} isWorking stopping draft="" />);

  assert.match(html, /aria-label="Stopping current task"/);
  assert.match(html, /Stopping…/);
  assert.match(html, /disabled=""/);
});
