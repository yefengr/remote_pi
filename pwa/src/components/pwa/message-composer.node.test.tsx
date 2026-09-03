import { expect, test } from "vitest";
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

  expect(html).toMatch(/pwa-textarea/);
  expect(html).toMatch(/pwa-composer-input/);
  expect(html).toMatch(/rows="1"/);
  expect(html).toMatch(/placeholder="Message your agent…"/);
  expect(imageTrigger).toMatch(/pwa-icon-button/);
  expect(imageTrigger).toMatch(/pwa-composer-icon/);
  expect(imageTrigger).toMatch(/aria-haspopup="menu"/);
  expect(imageTrigger).toMatch(/aria-expanded="false"/);
  expect(imageTrigger).toMatch(/title="Add image"/);
  expect(html).not.toMatch(/pwa-composer-menu-panel/);
  expect(commandTrigger).toMatch(/pwa-icon-button/);
  expect(commandTrigger).toMatch(/pwa-composer-icon/);
  expect(commandTrigger).toMatch(/aria-haspopup="menu"/);
  expect(commandTrigger).toMatch(/aria-expanded="false"/);
  expect(commandTrigger).toMatch(/title="Pi commands"/);
  expect(sendAction).toMatch(/pwa-icon-button/);
  expect(sendAction).toMatch(/data-tone="primary"/);
  expect(sendAction).toMatch(/type="submit"/);
  expect(sendAction).toMatch(/disabled=""/);
  expect(html).not.toMatch(/pwa-command-menu-panel/);
  expect(html).not.toMatch(/value="\/"/);
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

  expect(imageTrigger).toMatch(/aria-expanded="true"/);
  expect(imageMenu).toMatch(/bottom:auto/);
  expect(chooseImage).toMatch(/mantine-Menu-item/);
  expect(chooseImage).toMatch(/role="menuitem"/);
  expect(chooseImage).toMatch(/data-position="left"/);
  expect(useCamera).toMatch(/mantine-Menu-item/);
  expect(useCamera).toMatch(/role="menuitem"/);
  expect(useCamera).toMatch(/data-position="left"/);
  expect(html).not.toMatch(/display:none/);
});

test("disables the Mantine textarea, Pi commands trigger, and Send action while offline", () => {
  const html = renderComposer({ isOnline: false });
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? "";
  const trigger = buttonWithAriaLabel(html, "Pi commands");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  expect(textarea).toMatch(/disabled=""/);
  expect(trigger).toMatch(/disabled=""/);
  expect(sendAction).toMatch(/pwa-icon-button/);
  expect(sendAction).toMatch(/disabled=""/);
});

test("renders a disabled Mantine remove-image action while an image sends", () => {
  const html = renderComposer({ attachment: imageAttachment(), sendingImage: true });
  const removeAction = buttonWithAriaLabel(html, "Remove image");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  expect(removeAction).toMatch(/pwa-icon-button/);
  expect(removeAction).toMatch(/pwa-composer-remove/);
  expect(removeAction).toMatch(/title="Remove image"/);
  expect(removeAction).toMatch(/disabled=""/);
  expect(sendAction).toMatch(/disabled=""/);
});

test("shows a primary Mantine Stop button as the only action while working with an empty draft", () => {
  const html = renderComposer({ isWorking: true });
  const stopButton = buttonWithAriaLabel(html, "Stop current task");

  expect(stopButton).toMatch(/pwa-button/);
  expect(stopButton).toMatch(/data-tone="danger"/);
  expect(stopButton).toMatch(/pwa-stop-button/);
  expect(stopButton).toMatch(/primary/);
  expect(stopButton).toMatch(/type="button"/);
  expect(stopButton).toMatch(/data-position="left"/);
  expect(html).not.toMatch(/aria-label="Send message"/);
});

test("keeps the Mantine Stop button and Send action together when a draft exists", () => {
  const html = renderComposer({ isWorking: true, draft: "continue after this" });
  const stopButton = buttonWithAriaLabel(html, "Stop current task");
  const sendAction = buttonWithAriaLabel(html, "Send message");

  expect(stopButton).toMatch(/pwa-button/);
  expect(stopButton).toMatch(/pwa-stop-button/);
  expect(sendAction).toMatch(/pwa-icon-button/);
  expect(sendAction).toMatch(/data-tone="primary"/);
  expect(sendAction).toMatch(/type="submit"/);
  expect(sendAction).not.toMatch(/disabled=""/);
});

test("shows the pending Mantine stop state without exposing another Stop action", () => {
  const html = renderComposer({ isWorking: true, stopping: true });
  const stopButton = buttonWithAriaLabel(html, "Stopping current task");

  expect(stopButton).toMatch(/pwa-button/);
  expect(stopButton).toMatch(/disabled=""/);
  expect(stopButton).toMatch(/Stopping…/);
  expect(stopButton).toMatch(/title="Stopping current task"/);
  expect((html.match(/aria-label="(?:Stopping|Stop) current task"/g) ?? []).length).toBe(1);
});

test("disables Send when an attachment cannot be sent", () => {
  const html = renderComposer({ attachment: imageAttachment(), canAttachImage: false });
  const sendAction = buttonWithAriaLabel(html, "Send message");

  expect(sendAction).toMatch(/pwa-icon-button/);
  expect(sendAction).toMatch(/disabled=""/);
});
