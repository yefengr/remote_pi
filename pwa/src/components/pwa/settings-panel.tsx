"use client";

import { useRef, useState } from "react";
import { Drawer, Stack, Text } from "@mantine/core";
import { Button, Input } from "@/components/ui";
import { Check, RefreshCw, Trash2, X } from "lucide-react";

type SettingsPanelProps = {
  relayUrl: string;
  defaultRelayUrl: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
  onClearData: () => Promise<void>;
  onResetLayout: () => void;
  focusOrigin?: HTMLElement | null;
  focusFallbackSelectors?: readonly string[];
  withinPortal?: boolean;
};

export function SettingsPanel({ relayUrl, defaultRelayUrl, onSave, onClose, onClearData, onResetLayout, focusOrigin = null, focusFallbackSelectors = [], withinPortal = true }: SettingsPanelProps) {
  const [value, setValue] = useState(relayUrl);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const savePendingRef = useRef(false);
  const focusFallbackSelectorsRef = useRef(focusFallbackSelectors);

  const closeDrawer = () => {
    const content = contentRef.current;
    onClose();
    requestAnimationFrame(() => {
      if (content?.isConnected) return;
      const canFocus = (element: HTMLElement) => (
        element.isConnected
        && !element.matches(":disabled")
        && element.getClientRects().length > 0
        && !element.closest('[aria-hidden="true"]')
      );
      const activeElement = document.activeElement;
      const hasValidFocus = activeElement instanceof HTMLElement
        && activeElement !== document.body
        && activeElement !== document.documentElement
        && canFocus(activeElement);
      const candidates = [
        focusOrigin,
        ...focusFallbackSelectorsRef.current.map((selector) => document.querySelector<HTMLElement>(selector)),
      ];
      const focusTarget = candidates.find((candidate): candidate is HTMLElement => candidate !== null && canFocus(candidate));
      if (!hasValidFocus) focusTarget?.focus({ preventScroll: true });
    });
  };
  const save = async () => {
    if (savePendingRef.current) return;
    savePendingRef.current = true;
    try {
      await onSave(value);
    } finally {
      savePendingRef.current = false;
    }
  };

  return (
    <Drawer
      ref={contentRef}
      opened
      onClose={closeDrawer}
      position="right"
      size={360}
      withinPortal={withinPortal}
      portalProps={{ target: ".pwa-root" }}
      title={<div><span className="pwa-kicker">Preferences</span><Text span id="pwa-settings-title">Settings</Text></div>}
      aria-labelledby="pwa-settings-title"
      closeButtonProps={{ "aria-label": "Close settings", title: "Close settings", icon: <X size={18} /> }}
      overlayProps={{ backgroundOpacity: 0.74, blur: 10 }}
      classNames={{ content: "pwa-settings-drawer", header: "pwa-settings-drawer-head", title: "pwa-settings-title", close: "pwa-icon-button", body: "pwa-settings-body" }}
      styles={{
        content: { background: "rgba(8,11,13,.98)", borderLeft: "1px solid var(--pwa-line)", boxShadow: "-30px 0 80px rgba(0,0,0,.25)" },
        header: { padding: "28px 28px 0" },
        title: { minWidth: 0 },
        body: { padding: "34px 28px 28px" },
      }}
    >
      <Stack gap={0}>
        <Input
          className="pwa-field"
          label="Relay URL"
          description="Use https:// for a secure relay. WebSocket is selected automatically."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={defaultRelayUrl}
          spellCheck={false}
        />
        <div className="pwa-settings-note"><Check size={15} /><span>Owner identity and session history live in this browser only.</span></div>
        <Button tone="primary" type="button" onClick={() => void save()}>Save settings</Button>
        <Button tone="secondary" className="pwa-layout-reset-button" type="button" leftSection={<RefreshCw size={15} />} onClick={onResetLayout}>Reset layout</Button>
        <Text component="small" className="pwa-layout-reset-note">Closes panels, restores the chat scroll, and recalculates the viewport. Local data is kept.</Text>
        <Button tone="danger" type="button" leftSection={<Trash2 size={15} />} onClick={() => void onClearData()}>Clear local data</Button>
      </Stack>
    </Drawer>
  );
}
