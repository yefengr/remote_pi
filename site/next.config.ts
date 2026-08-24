import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  scope: "/app",
  swUrl: "/sw.js",
  disable: process.env.NODE_ENV !== "production",
  register: false,
  reloadOnOnline: false,
  cacheOnNavigation: false,
  globPublicPatterns: ["manifest.webmanifest", "app-icon-192.png", "app-icon-512.png", "logo.svg"],
});

const nextConfig: NextConfig = {
  output: "standalone",
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Content-Type", value: "application/javascript" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

export default withSerwist(nextConfig);
