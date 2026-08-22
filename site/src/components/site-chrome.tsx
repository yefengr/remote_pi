"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/header";
import { SiteFooter } from "@/components/footer";

export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPwa = pathname === "/app" || pathname.startsWith("/app/");

  if (isPwa) {
    return <main className="flex min-h-full w-full flex-1 flex-col">{children}</main>;
  }

  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
