import type { Metadata } from "next";
import { Space_Grotesk, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SiteChrome } from "@/components/site-chrome";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const body = Hanken_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const siteTagline = "Remote Pi — Your coding agents, in your browser";
const siteDescription =
  "Open Remote Pi as a browser PWA, pair it once, then drive any Pi coding agent — keep a fleet running 24/7 and link every machine into one mesh. Open source, self-hostable.";

export const metadata: Metadata = {
  metadataBase: new URL("https://remote-pi.jacobmoura.work"),
  title: {
    default: siteTagline,
    template: "%s · Remote Pi",
  },
  description: siteDescription,
  applicationName: "Remote Pi",
  authors: [{ name: "Flutterando", url: "https://flutterando.com.br" }],
  keywords: [
    "Remote Pi",
    "coding agents",
    "Pi coding agent",
    "browser agent control",
    "24/7 agent daemon",
    "agent mesh",
    "self-hostable relay",
  ],
  openGraph: {
    type: "website",
    url: "https://remote-pi.jacobmoura.work",
    title: siteTagline,
    description: siteDescription,
    siteName: "Remote Pi",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTagline,
    description: siteDescription,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <div className="app flex min-h-full flex-1 flex-col" id="top">
          <SiteChrome>{children}</SiteChrome>
        </div>
      </body>
    </html>
  );
}
