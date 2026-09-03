"use client";

import { useRef, useState } from "react";
import { Menu } from "@mantine/core";
import { IconButton } from "@/components/ui";
import { MoreHorizontal, RefreshCw, Settings } from "lucide-react";

type MobileTopbarMenuProps = {
  onRefresh: () => void | Promise<unknown>;
  onOpenSettings: () => void;
};

export function MobileTopbarMenu({ onRefresh, onOpenSettings }: MobileTopbarMenuProps) {
  const [open, setOpen] = useState(false);
  const refreshPending = useRef(false);

  return <div className="pwa-mobile-menu">
    <Menu
      closeOnEscape
      closeOnClickOutside
      onChange={setOpen}
      opened={open}
      position="bottom-end"
      transitionProps={{ duration: 0 }}
      withinPortal={false}
    >
      <Menu.Target>
        <IconButton aria-label="More options" title="More options">
          <MoreHorizontal size={20} />
        </IconButton>
      </Menu.Target>
      <Menu.Dropdown className="pwa-mobile-menu-panel">
        <Menu.Item
          leftSection={<RefreshCw size={17} />}
          onClick={async () => {
            if (refreshPending.current) return;
            refreshPending.current = true;
            setOpen(false);
            try {
              await onRefresh();
            } finally {
              refreshPending.current = false;
            }
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
