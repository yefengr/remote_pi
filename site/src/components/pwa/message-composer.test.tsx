import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerImageMenu, MessageComposer, type MessageComposerAttachment } from "./message-composer";
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

function buttonWithAriaLabel(html: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<button\\b(?=[^>]*\\baria-label="${escapedLabel}")[^>]*>(?:(?!<\\/button>)[\\s\\S])*?<\\/button>`))?.[0] ?? "";
}

function menuItemWithText(html: string, text: string): string {
  const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<button\\b(?=[^>]*\\brole="menuitem")[^>]*>(?:(?!<\\/button>)[\\s\\S])*?${escapedText}(?:(?!<\\/button>)[\\s\\S])*?<\\/button>`))?.[0] ?? "";
}

function imageAttachment(): MessageComposerAttachment {
  return {
    source: new Blob(["image"], { type: "image/png" }),
    previewUrl: "blob:image-preview",
    label: "Image attachment",
  };
}

test("renders the Mantine textarea, image menu, and action icons without changing the draft", () => {
  const html = renderComposer();
  const imageTrigger = buttonWithAriaLabel(html, "Add image");
  const commandTrigger = buttonWithAriaLabel(html, "Pi commands");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  assert.match(html, /pwa-textarea/);
  assert.match(html, /pwa-composer-input/);
  assert.match(html, /rows="1"/);
  assert.match(html, /placeholder="Message your agent…"/);
  assert.match(imageTrigger, /pwa-icon-button/);
  assert.match(imageTrigger, /pwa-composer-icon/);
  assert.match(imageTrigger, /aria-haspopup="menu"/);
  assert.match(imageTrigger, /aria-expanded="false"/);
  assert.match(imageTrigger, /title="Add image"/);
  assert.doesNotMatch(html, /pwa-composer-menu-panel/);
  assert.match(commandTrigger, /pwa-icon-button/);
  assert.match(commandTrigger, /pwa-composer-icon/);
  assert.match(commandTrigger, /aria-haspopup="menu"/);
  assert.match(commandTrigger, /aria-expanded="false"/);
  assert.match(commandTrigger, /title="Pi commands"/);
  assert.match(sendAction, /pwa-icon-button/);
  assert.match(sendAction, /data-tone="primary"/);
  assert.match(sendAction, /type="submit"/);
  assert.match(sendAction, /disabled=""/);
  assert.doesNotMatch(html, /pwa-command-menu-panel/);
  assert.doesNotMatch(html, /value="\/"/);
});

test("renders the opened Mantine image menu without disabling its focus trap", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <ComposerImageMenu disabled={false} opened onChange={() => {}} onChooseImage={() => {}} onUseCamera={() => {}} withinPortal={false} />
    </PwaUiProvider>,
  );
  const imageTrigger = buttonWithAriaLabel(html, "Add image");
  const chooseImage = menuItemWithText(html, "Choose image");
  const useCamera = menuItemWithText(html, "Use camera");
  const imageMenu = html.match(/<div[^>]*pwa-composer-menu-panel[^>]*>/)?.[0] ?? "";

  assert.match(imageTrigger, /aria-expanded="true"/);
  assert.match(imageMenu, /bottom:auto/);
  assert.match(chooseImage, /mantine-Menu-item/);
  assert.match(chooseImage, /role="menuitem"/);
  assert.match(chooseImage, /data-position="left"/);
  assert.match(useCamera, /mantine-Menu-item/);
  assert.match(useCamera, /role="menuitem"/);
  assert.match(useCamera, /data-position="left"/);
  assert.doesNotMatch(html, /display:none/);
});

test("disables the Mantine textarea, Pi commands trigger, and Send action while offline", () => {
  const html = renderComposer({ isOnline: false });
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? "";
  const trigger = buttonWithAriaLabel(html, "Pi commands");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  assert.match(textarea, /disabled=""/);
  assert.match(trigger, /disabled=""/);
  assert.match(sendAction, /pwa-icon-button/);
  assert.match(sendAction, /disabled=""/);
});

test("renders a disabled Mantine remove-image action while an image sends", () => {
  const html = renderComposer({ attachment: imageAttachment(), sendingImage: true });
  const removeAction = buttonWithAriaLabel(html, "Remove image");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  assert.match(removeAction, /pwa-icon-button/);
  assert.match(removeAction, /pwa-composer-remove/);
  assert.match(removeAction, /title="Remove image"/);
  assert.match(removeAction, /disabled=""/);
  assert.match(sendAction, /disabled=""/);
});

test("shows a primary Mantine Stop button as the only action while working with an empty draft", () => {
  const html = renderComposer({ isWorking: true });
  const stopButton = buttonWithAriaLabel(html, "Stop current task");

  assert.match(stopButton, /pwa-button/);
  assert.match(stopButton, /data-tone="danger"/);
  assert.match(stopButton, /pwa-stop-button/);
  assert.match(stopButton, /primary/);
  assert.match(stopButton, /type="button"/);
  assert.match(stopButton, /data-position="left"/);
  assert.doesNotMatch(html, /aria-label="Send message"/);
});

test("keeps the Mantine Stop button and Send action together when a draft exists", () => {
  const html = renderComposer({ isWorking: true, draft: "continue after this" });
  const stopButton = buttonWithAriaLabel(html, "Stop current task");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  assert.match(stopButton, /pwa-button/);
  assert.match(stopButton, /pwa-stop-button/);
  assert.match(sendAction, /pwa-icon-button/);
  assert.match(sendAction, /data-tone="primary"/);
  assert.match(sendAction, /type="submit"/);
  assert.doesNotMatch(sendAction, /disabled=""/);
});

test("shows the pending Mantine stop state without exposing another Stop action", () => {
  const html = renderComposer({ isWorking: true, stopping: true });
  const stopButton = buttonWithAriaLabel(html, "Stopping current task");

  assert.match(stopButton, /pwa-button/);
  assert.match(stopButton, /disabled=""/);
  assert.match(stopButton, /Stopping…/);
  assert.match(stopButton, /title="Stopping current task"/);
  assert.equal((html.match(/aria-label="(?:Stopping|Stop) current task"/g) ?? []).length, 1);
});

test("disables Send when an attachment cannot be sent", () => {
  const html = renderComposer({ attachment: imageAttachment(), canAttachImage: false });
  const sendAction = buttonWithAriaLabel(html, "Send message");

  assert.match(sendAction, /pwa-icon-button/);
  assert.match(sendAction, /disabled=""/);
});
