// Keep the publicly-served installer (/install.sh) in sync with its single
// source of truth: pi-extension/install.sh.
//
// Why a committed copy in public/ AND a sync step:
//   The Docker image is built with `pwa/` as the *only* build context
//   (push-docker.sh runs `docker buildx build … .` from this folder), so the
//   sibling `pi-extension/` directory is NOT reachable during the in-image
//   `pnpm build`. We therefore COMMIT `public/install.sh` (that's what the
//   image actually serves) and let this script refresh it from the source
//   whenever the monorepo IS present — i.e. local and CI builds. In Docker the
//   source is absent, so we no-op and trust the committed copy.
//
// Runs automatically as part of `pnpm build` (see package.json). The copy is
// kept BYTE-IDENTICAL to pi-extension/install.sh so what users curl|bash is
// exactly the script that was smoke-tested in the extension.

import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../pi-extension/install.sh");
const DEST = resolve(here, "../public/install.sh");

if (!existsSync(SRC)) {
  console.log(
    `[sync-install-sh] source not found (${SRC}) — using the committed public/install.sh`,
  );
  if (!existsSync(DEST)) {
    console.error(
      "[sync-install-sh] FATAL: public/install.sh is also missing — the PWA would 404 on /install.sh.",
    );
    process.exit(1);
  }
  process.exit(0);
}

copyFileSync(SRC, DEST);
console.log("[sync-install-sh] synced public/install.sh ← pi-extension/install.sh");
