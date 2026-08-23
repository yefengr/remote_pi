# Remote Pi Site

Next.js site for Remote Pi: landing page, documentation, legal pages, and the
browser PWA used to control Pi coding agents remotely.

Target domain: <https://remote-pi.jacobmoura.work>.

## Routes

- `/` - landing page and installation instructions
- `/app` - browser PWA workspace
- `/docs` - protocol, Relay, Agent Mesh, and Daemon reference
- `/tutorials/*` - PWA, local mesh, cross-PC mesh, and Daemon guides
- `/terms` - Terms of Service
- `/privacy` - Privacy Policy

## Stack

- Next.js 16 (App Router) + React 19
- TypeScript 5 (strict)
- Tailwind 4 (via `@tailwindcss/postcss`)
- ESLint 9
- Package manager: **pnpm**

The PWA uses IndexedDB for browser-local identity, pairings, session history,
and offline-readable messages. Its live connection goes through the existing
Relay and Pi Extension protocol.

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
│   ├── docs/                   # reference documentation
│   ├── tutorials/              # PWA, mesh, and Daemon guides
│   ├── privacy/                # privacy policy
│   ├── terms/                  # terms of service
│   ├── layout.tsx              # root layout and metadata
│   └── globals.css             # design tokens and page/PWA styles
├── components/
│   ├── pwa/                    # PWA workspace UI
│   ├── landing/                # public landing page
│   └── site-chrome.tsx         # website shell and PWA route split
└── lib/
    ├── pwa/                    # IndexedDB and browser persistence
    └── remote-pi/               # pairing, Relay, and wire protocol clients
```

## Conventions

- Server components by default; use client components only for state, events,
  browser APIs, or hooks.
- Keep PWA logic under `src/app/app/`, `src/components/pwa/`, and
  `src/lib/pwa/`; keep the public site and docs separate from the workspace.
- Do not add backend or API routes without explicit authorization.
- No analytics, tracking cookies, or native mobile client is shipped here.

## Deploy

The site is deployed as a Docker image. Follow the repository deployment
instructions in `site/CLAUDE.md`, `docker-compose.yml`, and
`scripts/deploy-self-hosted.sh`.
