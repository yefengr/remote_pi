"use client";

import { useState } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { MoreHorizontal, RefreshCw, Settings } from "lucide-react";

type MobileTopbarMenuProps = {
  onRefresh: () => void | Promise<void>;
  onOpenSettings: () => void;
};

export function MobileTopbarMenu({ onRefresh, onOpenSettings }: MobileTopbarMenuProps) {
  const [open, setOpen] = useState(false);

  return <div className="pwa-mobile-menu">
    <Menu
      closeOnEscape
      closeOnClickOutside
      keepMounted
      keepMountedMode="display-none"
      onChange={setOpen}
      opened={open}
      position="bottom-end"
      transitionProps={{ duration: 0 }}
      withinPortal={false}
    >
      <Menu.Target>
        <ActionIcon className="pwa-icon-button" aria-label="More options" title="More options">
          <MoreHorizontal size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<RefreshCw size={17} />}
          onClick={() => {
            setOpen(false);
            void onRefresh();
          }}
        >
          Refresh app
        </Menu.Item>
        <Menu.Item
          leftSection={<Settings size={17} />}
          onClick={() => {
            setOpen(false);
            onOpenSettings();
          }}
        >
          Settings
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  </div>;
}
