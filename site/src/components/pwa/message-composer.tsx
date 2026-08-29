"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type Ref } from "react";
import { Menu, Popover } from "@mantine/core";
import { Button, IconButton, Textarea } from "@/components/ui";
import { Camera, ImagePlus, LoaderCircle, Plus, Send, Slash, Square, X } from "lucide-react";
import { ComposerCommandMenu, type ComposerCommandAction } from "./composer-command-menu";
import type { ThinkingLevel, WireModel } from "@/lib/remote-pi/types";

export type MessageComposerAttachment = {
  source: Blob;
  previewUrl: string;
  label: string;
};

type ComposerImageMenuProps = {
  disabled: boolean;
  opened: boolean;
  onChange: (opened: boolean) => void;
  onChooseImage: () => void;
  onUseCamera: () => void;
  returnFocus?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  withinPortal?: boolean;
};

export function ComposerImageMenu({ disabled, opened, onChange, onChooseImage, onUseCamera, returnFocus = true, triggerRef, withinPortal = true }: ComposerImageMenuProps) {
  return <Menu
    closeOnEscape
    closeOnClickOutside
    floatingStrategy="fixed"
    onChange={onChange}
    opened={opened}
    portalProps={{ target: ".pwa-root" }}
    position="top-start"
    returnFocus={returnFocus}
    transitionProps={{ duration: 0 }}
    withinPortal={withinPortal}
    zIndex={21}
  >
    <Menu.Target>
      <IconButton ref={triggerRef} className="pwa-composer-icon" type="button" disabled={disabled} aria-label="Add image" title="Add image"><Plus size={19} /></IconButton>
    </Menu.Target>
    <Menu.Dropdown className="pwa-composer-menu-panel" style={{ bottom: "auto" }}>
      <Menu.Item leftSection={<ImagePlus size={17} />} onClick={onChooseImage}>Choose image</Menu.Item>
      <Menu.Item leftSection={<Camera size={17} />} onClick={onUseCamera}>Use camera</Menu.Item>
    </Menu.Dropdown>
  </Menu>;
}

function hasValidPageFocus() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement
    && activeElement !== document.body
    && activeElement !== document.documentElement
    && activeElement.isConnected;
}

function scheduleFocusReturn(
  frameRef: { current: number | null },
  triggerRef: { current: HTMLButtonElement | null },
) {
  if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = null;
    if (!hasValidPageFocus()) triggerRef.current?.focus({ preventScroll: true });
  });
}

type MessageComposerProps = {
  attachment: MessageComposerAttachment | null;
  canAttachImage: boolean;
  sendingImage: boolean;
  isOnline: boolean;
  isWorking: boolean;
  stopping: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void;
  onSetAttachment: (source: Blob, label: string) => void;
  onClearAttachment: () => void;
  commandModels: WireModel[];
  commandCurrentModel: WireModel | null;
  commandCurrentModelFallback: string | null;
  commandThinking: ThinkingLevel;
  commandPendingAction: ComposerCommandAction | null;
  onNewSession: () => void;
  onCompactSession: () => void;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onCommandsOpen: () => void;
};

export function MessageComposer({
  attachment,
  canAttachImage,
  sendingImage,
  isOnline,
  isWorking,
  stopping,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onSetAttachment,
  onClearAttachment,
  commandModels,
  commandCurrentModel,
  commandCurrentModelFallback,
  commandThinking,
  commandPendingAction,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onCommandsOpen,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const imageMenuOpenRef = useRef(false);
  const commandMenuOpenRef = useRef(false);
  const imageFocusFrameRef = useRef<number | null>(null);
  const commandFocusFrameRef = useRef<number | null>(null);
  const sendPendingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);

  const setImageMenuOpened = useCallback((opened: boolean) => {
    const wasOpen = imageMenuOpenRef.current;
    imageMenuOpenRef.current = opened;
    setMenuOpen(opened);
    if (!opened && wasOpen) scheduleFocusReturn(imageFocusFrameRef, imageTriggerRef);
  }, []);

  const setCommandMenuOpened = useCallback((opened: boolean) => {
    const wasOpen = commandMenuOpenRef.current;
    commandMenuOpenRef.current = opened;
    setCommandMenuOpen(opened);
    if (!opened && wasOpen) scheduleFocusReturn(commandFocusFrameRef, commandTriggerRef);
  }, []);

  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(Math.max(textarea.scrollHeight, 44), 120);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden";
  };

  useLayoutEffect(() => {
    resizeTextarea();
  }, [draft]);

  useEffect(() => {
    if (!commandMenuOpen) return;
    const closeCommandMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCommandMenuOpened(false);
    };
    document.addEventListener("keydown", closeCommandMenuOnEscape);
    return () => document.removeEventListener("keydown", closeCommandMenuOnEscape);
  }, [commandMenuOpen, setCommandMenuOpened]);

  useEffect(() => () => {
    if (imageFocusFrameRef.current !== null) cancelAnimationFrame(imageFocusFrameRef.current);
    if (commandFocusFrameRef.current !== null) cancelAnimationFrame(commandFocusFrameRef.current);
  }, []);

  const hasMessage = Boolean(draft.trim() || attachment);
  const showStop = isOnline && isWorking;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendPendingRef.current) return;
    sendPendingRef.current = true;
    try {
      await onSend();
    } finally {
      sendPendingRef.current = false;
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    onSetAttachment(image, image.name || "Clipboard image");
  };

  const chooseImage = () => {
    setImageMenuOpened(false);
    fileInputRef.current?.click();
  };

  const useCamera = () => {
    setImageMenuOpened(false);
    cameraInputRef.current?.click();
  };

  const toggleCommands = () => {
    const nextOpen = !commandMenuOpenRef.current;
    setImageMenuOpened(false);
    setCommandMenuOpened(nextOpen);
    if (nextOpen) onCommandsOpen();
  };

  return (
    <form className="pwa-composer" onSubmit={handleSubmit}>
      <input ref={fileInputRef} className="pwa-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSetAttachment(file, file.name || "Image attachment"); event.currentTarget.value = ""; }} />
      <input ref={cameraInputRef} className="pwa-image-input" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSetAttachment(file, file.name || "Camera image"); event.currentTarget.value = ""; }} />
      <div className="pwa-composer-card">
        {attachment ? <div className="pwa-composer-preview"><img src={attachment.previewUrl} alt={attachment.label} /><IconButton className="pwa-composer-remove" type="button" onClick={onClearAttachment} disabled={sendingImage} aria-label="Remove image" title="Remove image"><X size={14} /></IconButton></div> : null}
        <Textarea ref={textareaRef} classNames={{ root: "pwa-composer-textarea", input: "pwa-composer-input" }} resize="none" value={draft} onChange={(event) => onDraftChange(event.target.value)} onPaste={handlePaste} placeholder={isOnline ? "Message your agent…" : "Reconnect to send a message"} disabled={!isOnline || sendingImage} rows={1} />
        <div className="pwa-composer-footer">
          <div className="pwa-composer-tools">
            <div className="pwa-composer-menu">
              <ComposerImageMenu
                disabled={!canAttachImage}
                opened={menuOpen}
                onChange={(opened) => {
                  if (opened) setCommandMenuOpened(false);
                  setImageMenuOpened(opened);
                }}
                onChooseImage={chooseImage}
                onUseCamera={useCamera}
                returnFocus={false}
                triggerRef={imageTriggerRef}
              />
            </div>
            <div className="pwa-composer-command">
              <Popover opened={commandMenuOpen} onChange={setCommandMenuOpened} closeOnClickOutside closeOnEscape position="top-start" offset={{ mainAxis: 8, crossAxis: -52 }} transitionProps={{ duration: 0 }} floatingStrategy="fixed" withinPortal portalProps={{ target: ".pwa-root" }} zIndex={8}>
                <Popover.Target popupType="menu">
                  <IconButton ref={commandTriggerRef} className="pwa-composer-icon" type="button" onClick={toggleCommands} disabled={!isOnline} aria-label="Pi commands" title="Pi commands"><Slash size={19} /></IconButton>
                </Popover.Target>
                <Popover.Dropdown className="pwa-command-menu-dropdown" role="menu" aria-label="Pi commands">
                  <ComposerCommandMenu
                    isOnline={isOnline}
                    isWorking={isWorking}
                    pendingAction={commandPendingAction}
                    models={commandModels}
                    currentModel={commandCurrentModel}
                    currentModelFallback={commandCurrentModelFallback}
                    thinking={commandThinking}
                    onNewSession={() => { setCommandMenuOpened(false); onNewSession(); }}
                    onCompactSession={() => { setCommandMenuOpened(false); onCompactSession(); }}
                    onSetModel={(model) => { setCommandMenuOpened(false); onSetModel(model); }}
                    onSetThinking={(level) => { setCommandMenuOpened(false); onSetThinking(level); }}
                  />
                </Popover.Dropdown>
              </Popover>
            </div>
          </div>
          <div className="pwa-composer-actions">
            {showStop ? <Button tone="danger" className={`pwa-stop-button${hasMessage ? "" : " primary"}`} type="button" onClick={onStop} disabled={stopping} aria-label={stopping ? "Stopping current task" : "Stop current task"} title={stopping ? "Stopping current task" : "Stop current task"} leftSection={stopping ? <LoaderCircle className="pwa-spin" size={16} /> : <Square size={15} fill="currentColor" />}><span>{stopping ? "Stopping…" : "Stop"}</span></Button> : null}
            {hasMessage || !showStop ? <IconButton tone="primary" type="submit" disabled={!isOnline || sendingImage || !hasMessage || (attachment !== null && !canAttachImage)} aria-label="Send message" title="Send message"><Send size={17} /></IconButton> : null}
          </div>
        </div>
      </div>
    </form>
  );
}
