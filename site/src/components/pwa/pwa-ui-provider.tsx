"use client";

import { MantineProvider } from "@mantine/core";
import { remotePiTheme } from "@/lib/ui/remote-pi-theme";

export function PwaUiProvider({ children }: { children: React.ReactNode }) {
  return <MantineProvider theme={remotePiTheme} forceColorScheme="dark" cssVariablesSelector=".pwa-ui-scope" getRootElement={() => document.querySelector<HTMLElement>(".pwa-ui-scope") ?? document.documentElement}><div className="pwa-ui-scope">{children}</div></MantineProvider>;
}
