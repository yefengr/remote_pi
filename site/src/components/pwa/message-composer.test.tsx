import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageComposer, type MessageComposerAttachment } from "./message-composer";
import { PwaUiProvider } from "./pwa-ui-provider";

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
  commandCurrentModelFallback: null,
  commandThinking: "off" as const,
  commandPendingAction: null,
  onNewSession: () => {},
  onCompactSession: () => {},
  onSetModel: () => {},
  onSetThinking: () => {},
  onCommandsOpen: () => {},
};

function renderComposer(overrides: Partial<ComponentProps<typeof MessageComposer>> = {}) {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <MessageComposer {...commonProps} draft="" isOnline isWorking={false} {...overrides} />
    </PwaUiProvider>,
  );
}

test("renders the Mantine textarea and action icons without changing the draft", () => {
  const html = renderComposer();
  const imageTrigger = html.match(/<button[^>]*aria-label="Add image"[^>]*>/)?.[0] ?? "";
  const commandTrigger = html.match(/<button[^>]*aria-label="Pi commands"[^>]*>/)?.[0] ?? "";

  assert.match(html, /mantine-Textarea-root/);
  assert.match(html, /mantine-Textarea-input/);
  assert.match(html, /pwa-composer-input/);
  assert.match(html, /rows="1"/);
  assert.match(html, /placeholder="Message your agent…"/);
  assert.match(imageTrigger, /mantine-ActionIcon-root/);
  assert.match(imageTrigger, /pwa-composer-icon/);
  assert.match(imageTrigger, /title="Add image"/);
  assert.match(commandTrigger, /mantine-ActionIcon-root/);
  assert.match(commandTrigger, /pwa-composer-icon/);
  assert.match(commandTrigger, /title="Pi commands"/);
  assert.doesNotMatch(html, /value="\/"/);
});

test("disables the Mantine textarea and Pi commands trigger while offline", () => {
  const html = renderComposer({ isOnline: false });
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? "";
  const trigger = html.match(/<button[^>]*aria-label="Pi commands"[^>]*>/)?.[0] ?? "";

  assert.match(textarea, /disabled=""/);
  assert.match(trigger, /disabled=""/);
});

test("renders a disabled Mantine remove-image action while an image sends", () => {
  const attachment: MessageComposerAttachment = {
    source: new Blob(["image"], { type: "image/png" }),
    previewUrl: "blob:image-preview",
    label: "Image attachment",
  };
  const html = renderComposer({ attachment, sendingImage: true });
  const removeAction = html.match(/<button[^>]*aria-label="Remove image"[^>]*>/)?.[0] ?? "";

  assert.match(removeAction, /mantine-ActionIcon-root/);
  assert.match(removeAction, /pwa-composer-remove/);
  assert.match(removeAction, /title="Remove image"/);
  assert.match(removeAction, /disabled=""/);
});

test("shows Stop as the only primary action while working with an empty draft", () => {
  const html = renderComposer({ isWorking: true });

  assert.match(html, /aria-label="Stop current task"/);
  assert.doesNotMatch(html, /aria-label="Send message"/);
});

test("keeps Send available beside Stop when a draft exists", () => {
  const html = renderComposer({ isWorking: true, draft: "continue after this" });

  assert.match(html, /aria-label="Stop current task"/);
  assert.match(html, /aria-label="Send message"/);
});

test("shows the pending stop state without exposing another Stop action", () => {
  const html = renderComposer({ isWorking: true, stopping: true });

  assert.match(html, /aria-label="Stopping current task"/);
  assert.match(html, /Stopping…/);
  assert.match(html, /disabled=""/);
});
