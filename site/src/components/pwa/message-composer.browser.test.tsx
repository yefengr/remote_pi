import { useState } from "react";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { ThinkingLevel, WireModel } from "@/lib/remote-pi/types";
import { MessageComposer, type MessageComposerAttachment } from "./message-composer";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200_000,
  vision: true,
};

type ComposerHarnessProps = {
  initialDraft?: string;
  initialWorking?: boolean;
  onCommandsOpen?: () => void;
  onSend?: () => void | Promise<void>;
  onStop?: () => void;
  onSetAttachment?: (source: Blob, label: string) => void;
  onSetModel?: (nextModel: WireModel) => void;
  onSetThinking?: (level: ThinkingLevel) => void;
};

function attachmentFrom(source: Blob, label: string): MessageComposerAttachment {
  return {
    source,
    previewUrl: "data:image/png;base64,",
    label,
  };
}

function ComposerHarness({
  initialDraft = "",
  initialWorking = false,
  onCommandsOpen = () => {},
  onSend = () => {},
  onStop = () => {},
  onSetAttachment = () => {},
  onSetModel = () => {},
  onSetThinking = () => {},
}: ComposerHarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [attachment, setAttachment] = useState<MessageComposerAttachment | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [isWorking, setIsWorking] = useState(initialWorking);
  const [stopping, setStopping] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const [pendingAction, setPendingAction] = useState<"model_set" | null>(null);

  const setImageAttachment = (source: Blob, label: string) => {
    onSetAttachment(source, label);
    setAttachment(attachmentFrom(source, label));
  };

  return (
    <>
      <button type="button" data-testid="composer-set-draft" hidden onClick={() => setDraft("Continue this task")} />
      <button type="button" data-testid="composer-toggle-working" hidden onClick={() => setIsWorking((current) => !current)} />
      <button type="button" data-testid="composer-set-stopping" hidden onClick={() => setStopping(true)} />
      <button type="button" data-testid="composer-set-attachment" hidden onClick={() => setAttachment(attachmentFrom(new Blob(["image"], { type: "image/png" }), "Queued image"))} />
      <button type="button" data-testid="composer-set-sending-image" hidden onClick={() => setSendingImage(true)} />
      <button type="button" data-testid="composer-go-offline" hidden onClick={() => setIsOnline(false)} />
      <button type="button" data-testid="composer-set-command-pending" hidden onClick={() => setPendingAction("model_set")} />
      <MessageComposer
        attachment={attachment}
        canAttachImage={isOnline && !sendingImage}
        sendingImage={sendingImage}
        isOnline={isOnline}
        isWorking={isWorking}
        stopping={stopping}
        draft={draft}
        onDraftChange={setDraft}
        onSend={onSend}
        onStop={onStop}
        onSetAttachment={setImageAttachment}
        onClearAttachment={() => setAttachment(null)}
        commandModels={[model]}
        commandCurrentModel={model}
        commandCurrentModelFallback={null}
        commandThinking="medium"
        commandPendingAction={pendingAction}
        onNewSession={() => {}}
        onCompactSession={() => {}}
        onSetModel={onSetModel}
        onSetThinking={onSetThinking}
        onCommandsOpen={onCommandsOpen}
      />
    </>
  );
}

test("keeps the image remove action at a 44px touch target", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  screen.getByTestId("composer-set-attachment").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const remove = screen.getByRole("button", { name: "Remove image" });
  await expect.element(remove).toBeVisible();
  const rect = remove.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("keeps the empty-draft Stop action visually emphasized", async () => {
  const screen = await renderPwa(<ComposerHarness initialWorking />);
  const stop = screen.getByRole("button", { name: "Stop current task" }).element();
  const style = window.getComputedStyle(stop);

  expect(style.backgroundColor).toBe("rgb(255, 107, 107)");
  expect(style.color).toBe("rgb(27, 7, 7)");
});

function getImageInputs(): [HTMLInputElement, HTMLInputElement] {
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input.pwa-image-input")];
  expect(inputs).toHaveLength(2);
  return [inputs[0], inputs[1]];
}

function closePopoverFromOutside() {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function settleOverlayFocus() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
}

test("portals mutually exclusive image and Pi command menus, then returns focus after closing", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  const imageTrigger = screen.getByRole("button", { name: "Add image" });
  const commandTrigger = screen.getByRole("button", { name: "Pi commands" });

  imageTrigger.element().focus();
  await expect.element(imageTrigger).toHaveFocus();
  await imageTrigger.click();
  const chooseImage = screen.getByRole("menuitem", { name: "Choose image" });
  await expect.element(chooseImage).toBeVisible();
  expect(chooseImage.element().closest(".pwa-root")).not.toBeNull();
  chooseImage.element().focus();
  await expect.element(chooseImage).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(chooseImage).not.toBeInTheDocument();
  await expect.element(imageTrigger).toHaveFocus();

  await imageTrigger.click();
  await expect.element(screen.getByRole("menuitem", { name: "Choose image" })).toBeVisible();
  commandTrigger.element().focus();
  await commandTrigger.click();
  await expect.element(screen.getByRole("menuitem", { name: "Choose image" })).not.toBeInTheDocument();
  const commandsMenu = screen.getByRole("menu", { name: "Pi commands" });
  await expect.element(commandsMenu).toBeVisible();
  expect(commandsMenu.element().closest(".pwa-root")).not.toBeNull();
  await settleOverlayFocus();
  await expect.element(commandTrigger).toHaveFocus();
  const modelCommand = screen.getByRole("menuitem", { name: /\/model/ });
  modelCommand.element().focus();
  await expect.element(modelCommand).toHaveFocus();
  closePopoverFromOutside();
  await expect.element(commandsMenu).not.toBeInTheDocument();
  await expect.element(commandTrigger).toHaveFocus();
});

test("uses the exact hidden image inputs and only captures pasted image files", async () => {
  const attachments: Array<{ source: Blob; label: string }> = [];
  const screen = await renderPwa(<ComposerHarness onSetAttachment={(source, label) => attachments.push({ source, label })} />);
  const [imageInput, cameraInput] = getImageInputs();
  const imageTrigger = screen.getByRole("button", { name: "Add image" });

  expect(imageInput.accept).toBe("image/png,image/jpeg,image/webp");
  expect(cameraInput.accept).toBe("image/png,image/jpeg,image/webp");
  expect(cameraInput.getAttribute("capture")).toBe("environment");

  let imageClicks = 0;
  let cameraClicks = 0;
  imageInput.addEventListener("click", () => { imageClicks += 1; });
  cameraInput.addEventListener("click", () => { cameraClicks += 1; });

  await imageTrigger.click();
  await screen.getByRole("menuitem", { name: "Choose image" }).click();
  expect(imageClicks).toBe(1);
  expect(cameraClicks).toBe(0);

  await imageTrigger.click();
  await screen.getByRole("menuitem", { name: "Use camera" }).click();
  expect(imageClicks).toBe(1);
  expect(cameraClicks).toBe(1);

  const textarea = screen.getByRole("textbox").element() as HTMLTextAreaElement;
  const imageFile = new File(["image"], "clipboard.webp", { type: "image/webp" });
  const imageClipboard = new DataTransfer();
  imageClipboard.items.add(imageFile);
  const imagePaste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: imageClipboard,
  });
  textarea.dispatchEvent(imagePaste);
  expect(imagePaste.defaultPrevented).toBe(true);
  expect(attachments).toEqual([{ source: imageFile, label: "clipboard.webp" }]);

  const textFile = new File(["plain text"], "notes.txt", { type: "text/plain" });
  const textClipboard = new DataTransfer();
  textClipboard.items.add(textFile);
  const textPaste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: textClipboard,
  });
  textarea.dispatchEvent(textPaste);
  expect(textPaste.defaultPrevented).toBe(false);
  expect(attachments).toHaveLength(1);
});

test("navigates Pi commands to model and thinking choices, reports opens, and closes after each selection", async () => {
  let commandOpens = 0;
  const selectedModels: WireModel[] = [];
  const selectedThinking: ThinkingLevel[] = [];
  const screen = await renderPwa(
    <ComposerHarness
      onCommandsOpen={() => { commandOpens += 1; }}
      onSetModel={(nextModel) => selectedModels.push(nextModel)}
      onSetThinking={(level) => selectedThinking.push(level)}
    />,
  );
  const commandTrigger = screen.getByRole("button", { name: "Pi commands" });

  await commandTrigger.click();
  expect(commandOpens).toBe(1);
  await screen.getByRole("menuitem", { name: /\/model/ }).click();
  const modelGroup = screen.getByRole("group", { name: "Change model" });
  await expect.element(modelGroup).toBeVisible();
  await screen.getByRole("menuitem", { name: /anthropic \/ Claude Sonnet 4/ }).click();
  expect(selectedModels).toEqual([model]);
  await expect.element(modelGroup).not.toBeInTheDocument();

  await commandTrigger.click();
  expect(commandOpens).toBe(2);
  await screen.getByRole("menuitem", { name: /\/thinking/ }).click();
  const thinkingGroup = screen.getByRole("group", { name: "Thinking level" });
  await expect.element(thinkingGroup).toBeVisible();
  await expect.element(screen.getByLabelText("Current thinking level")).toBeVisible();
  await screen.getByRole("menuitem", { name: "high", exact: true }).click();
  expect(selectedThinking).toEqual(["high"]);
  await expect.element(thinkingGroup).not.toBeInTheDocument();
});

test("gates root Pi commands while working and disables every command when an action is pending", async () => {
  const screen = await renderPwa(<ComposerHarness initialWorking />);
  await screen.getByRole("button", { name: "Pi commands" }).click();
  const newSession = screen.getByRole("menuitem", { name: /\/new/ });
  const modelCommand = screen.getByRole("menuitem", { name: /\/model/ });
  await expect.element(newSession).toBeDisabled();
  await expect.element(modelCommand).toBeEnabled();

  screen.getByTestId("composer-set-command-pending").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(modelCommand).toBeDisabled();
  await expect.element(screen.getByRole("menuitem", { name: /\/thinking/ })).toBeDisabled();
});

test("updates Stop and Send client state through working, stopping, image sending, and offline transitions", async () => {
  let stopCalls = 0;
  let sendCalls = 0;
  const screen = await renderPwa(
    <ComposerHarness
      onStop={() => { stopCalls += 1; }}
      onSend={() => { sendCalls += 1; }}
    />,
  );
  const textarea = screen.getByRole("textbox");

  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  screen.getByTestId("composer-toggle-working").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const stop = screen.getByRole("button", { name: "Stop current task" });
  await expect.element(stop).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  await stop.click();
  expect(stopCalls).toBe(1);

  screen.getByTestId("composer-set-draft").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const send = screen.getByRole("button", { name: "Send message" });
  await expect.element(send).toBeEnabled();
  await send.click();
  expect(sendCalls).toBe(1);

  screen.getByTestId("composer-set-stopping").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(screen.getByRole("button", { name: "Stopping current task" })).toBeDisabled();

  screen.getByTestId("composer-set-attachment").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  screen.getByTestId("composer-set-sending-image").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(textarea).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

  screen.getByTestId("composer-go-offline").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(textarea).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Pi commands" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Add image" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("prevents duplicate native submits until an asynchronous send settles, then permits the next submit", async () => {
  let attempts = 0;
  let completed = false;
  let resolveSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  const screen = await renderPwa(
    <ComposerHarness
      initialDraft="Review this change"
      onSend={() => {
        attempts += 1;
        return pendingSend.then(() => { completed = true; });
      }}
    />,
  );
  const form = document.querySelector<HTMLFormElement>("form.pwa-composer");
  expect(form).not.toBeNull();

  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);
  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);
  const attemptsBeforeCompletion = attempts;

  resolveSend();
  await expect.poll(() => completed).toBe(true);
  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);

  expect(attemptsBeforeCompletion).toBe(1);
  expect(attempts).toBe(2);
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});
