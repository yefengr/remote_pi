"use client";

import { useState } from "react";
import { Button, Drawer, Stack, Text, TextInput } from "@mantine/core";
import { Check, RefreshCw, Trash2, X } from "lucide-react";

type SettingsPanelProps = {
  relayUrl: string;
  defaultRelayUrl: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
  onClearData: () => Promise<void>;
  onResetLayout: () => void;
  withinPortal?: boolean;
};

export function SettingsPanel({ relayUrl, defaultRelayUrl, onSave, onClose, onClearData, onResetLayout, withinPortal = true }: SettingsPanelProps) {
  const [value, setValue] = useState(relayUrl);

  return (
    <Drawer
      opened
      onClose={onClose}
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
        <TextInput
          className="pwa-field"
          label="Relay URL"
          description="Use https:// for a secure relay. WebSocket is selected automatically."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={defaultRelayUrl}
          spellCheck={false}
        />
        <div className="pwa-settings-note"><Check size={15} /><span>Owner identity and session history live in this browser only.</span></div>
        <Button className="pwa-primary-button" type="button" onClick={() => void onSave(value)}>Save settings</Button>
        <Button className="pwa-secondary-button pwa-layout-reset-button" type="button" variant="default" leftSection={<RefreshCw size={15} />} onClick={onResetLayout}>Reset layout</Button>
        <Text component="small" className="pwa-layout-reset-note">Closes panels, restores the chat scroll, and recalculates the viewport. Local data is kept.</Text>
        <Button className="pwa-danger-button" type="button" variant="outline" color="red" leftSection={<Trash2 size={15} />} onClick={() => void onClearData()}>Clear local data</Button>
      </Stack>
    </Drawer>
  );
}
