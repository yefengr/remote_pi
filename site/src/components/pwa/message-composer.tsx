"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { Camera, ImagePlus, LoaderCircle, Plus, Send, Square, X } from "lucide-react";

export type MessageComposerAttachment = {
  source: Blob;
  previewUrl: string;
  label: string;
};

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
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const hasMessage = Boolean(draft.trim() || attachment);
  const showStop = isOnline && isWorking;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSend();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    onSetAttachment(image, image.name || "Clipboard image");
  };

  const chooseImage = () => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  const useCamera = () => {
    setMenuOpen(false);
    cameraInputRef.current?.click();
  };

  return (
    <form className="pwa-composer" onSubmit={handleSubmit}>
      <input ref={fileInputRef} className="pwa-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSetAttachment(file, file.name || "Image attachment"); event.currentTarget.value = ""; }} />
      <input ref={cameraInputRef} className="pwa-image-input" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSetAttachment(file, file.name || "Camera image"); event.currentTarget.value = ""; }} />
      <div className="pwa-composer-card">
        {attachment ? <div className="pwa-composer-preview"><img src={attachment.previewUrl} alt={attachment.label} /><button type="button" onClick={onClearAttachment} disabled={sendingImage} aria-label="Remove image" title="Remove image"><X size={14} /></button></div> : null}
        <textarea ref={textareaRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} onPaste={handlePaste} placeholder={isOnline ? "Message your agent…" : "Reconnect to send a message"} disabled={!isOnline || sendingImage} rows={1} />
        <div className="pwa-composer-footer">
          <div className="pwa-composer-menu" ref={menuRef}>
            <button className="pwa-composer-icon" type="button" onClick={() => setMenuOpen((open) => !open)} disabled={!canAttachImage} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Add image" title="Add image"><Plus size={19} /></button>
            {menuOpen ? <div className="pwa-composer-menu-panel">
              <button type="button" onClick={chooseImage}><ImagePlus size={17} />Choose image</button>
              <button type="button" onClick={useCamera}><Camera size={17} />Use camera</button>
            </div> : null}
          </div>
          <div className="pwa-composer-actions">
            {showStop ? <button className={`pwa-stop-button${hasMessage ? "" : " primary"}`} type="button" onClick={onStop} disabled={stopping} aria-label={stopping ? "Stopping current task" : "Stop current task"} title={stopping ? "Stopping current task" : "Stop current task"}>{stopping ? <LoaderCircle className="pwa-spin" size={16} /> : <Square size={15} fill="currentColor" />}<span>{stopping ? "Stopping…" : "Stop"}</span></button> : null}
            {hasMessage || !showStop ? <button className="pwa-primary-button" type="submit" disabled={!isOnline || sendingImage || !hasMessage || (attachment !== null && !canAttachImage)} aria-label="Send message" title="Send message"><Send size={17} /></button> : null}
          </div>
        </div>
      </div>
    </form>
  );
}
