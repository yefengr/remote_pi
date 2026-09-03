import type { Metadata, Viewport } from "next";
import "@mantine/core/styles.css";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Remote Pi App",
  description: "Control your Pi coding agents from a browser.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black",
    title: "Remote Pi",
  },
};

export default function PwaLayout({ children }: { children: React.ReactNode }) {
  return (
    <PwaUiProvider>
      <ServiceWorkerRegister />
      {children}
    </PwaUiProvider>
  );
}
