"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, RefreshCw, Settings } from "lucide-react";

type MobileTopbarMenuProps = {
  onRefresh: () => void | Promise<void>;
  onOpenSettings: () => void;
};

export function MobileTopbarMenu({ onRefresh, onOpenSettings }: MobileTopbarMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="pwa-mobile-menu" ref={menuRef}>
    <button className="pwa-icon-button" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="More options" title="More options"><MoreHorizontal size={20} /></button>
    {open ? <div className="pwa-mobile-menu-panel">
      <button type="button" onClick={() => { setOpen(false); void onRefresh(); }}><RefreshCw size={17} />Refresh app</button>
      <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}><Settings size={17} />Settings</button>
    </div> : null}
  </div>;
}
