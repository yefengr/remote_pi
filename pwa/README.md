# Remote Pi PWA

Next.js browser PWA for remotely controlling Pi coding agents.

Target domain: <https://remote-pi.jacobmoura.work>.

## Routes

- `/app` — browser PWA workspace and the only product route.
- `/` — Next server redirect to `/app`; it intentionally remains available so
  the Docker healthcheck at the root path succeeds.

The PWA uses IndexedDB for browser-local identity, pairings, session history,
and offline-readable messages. Its live connection goes through the existing
Relay and Pi Extension protocol.

## Stack

- Next.js 16 (App Router) + React 19
- TypeScript 5 (strict)
- Tailwind 4 (via `@tailwindcss/postcss`)
- ESLint 9
- Package manager: **pnpm**

## Commands

```bash
pnpm install   # install dependencies
pnpm dev       # dev server at http://localhost:3000
pnpm build     # production build
pnpm start     # serve the production build
pnpm lint      # ESLint
```

## Layout

```
src/
├── app/
│   ├── app/                    # PWA route
│   ├── layout.tsx              # root layout
│   ├── page.tsx                # root redirect to /app
│   └── globals.css             # design tokens and PWA styles
├── components/
│   ├── pwa/                    # PWA workspace UI
│   └── ui/                     # PWA base UI wrappers
└── lib/
    ├── pwa/                    # IndexedDB and browser persistence
    └── remote-pi/              # pairing, Relay, and wire protocol clients
```

## Conventions

- Server components by default; use client components only for state, events,
  browser APIs, or hooks.
- Keep PWA logic under `src/app/app/`, `src/components/pwa/`, and
  `src/lib/pwa/`.
- Do not add backend or API routes without explicit authorization.
- No analytics, tracking cookies, public marketing/docs pages, or native mobile
  client is shipped here.

## Deploy

The PWA is deployed as a Docker image. The root-path healthcheck remains
valid because `/` redirects to `/app`. Follow the repository deployment
instructions in `pwa/CLAUDE.md`, `docker-compose.yml`, and
`scripts/deploy-self-hosted.sh`.
