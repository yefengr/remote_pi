# Remote Pi — PWA (NextJS)

Subprojeto web do Remote Pi. Contém somente o PWA browser em
`src/app/app/`, `src/components/pwa/` e `src/lib/pwa/`. A única rota de produto
é `/app`; `/` usa redirecionamento de servidor para `/app` para manter o
healthcheck Docker na raiz funcional.

## Stack

- NextJS 16 (App Router)
- React 19
- TypeScript 5
- Tailwind 4 (via `@tailwindcss/postcss`)
- ESLint 9
- Package manager: **pnpm** (com `allowBuilds` para `sharp` e `unrs-resolver` em `pnpm-workspace.yaml`)

## Comandos

- `pnpm install` — instala deps
- `pnpm dev` — dev server em :3000
- `pnpm build` — build de produção
- `pnpm start` — serve build
- `pnpm lint` — ESLint

## Convenções

- **Server Components por padrão** — só usar `"use client"` quando necessário (state, events, hooks)
- **Pasta de rotas**: `src/app/` (App Router)
- **Estilos**: Tailwind utility-first. Sem CSS modules / styled-components
- **Imagens**: `next/image` com fallback estático onde possível
- **Tipagem**: props de componentes sempre tipadas, sem `any`

## Escopo e restrições

- Features do PWA browser ficam neste subprojeto e devem permanecer em
  `src/app/app/`, `src/components/pwa/` e `src/lib/pwa/`.
- Não reintroduza landing page, documentação pública ou páginas legais na PWA; a
  interface de produto permanece exclusivamente em `/app`.
- Não adicionar backend ou API routes sem autorização explícita.
- Não comitar `.next/`, `out/`, `node_modules/` (já no .gitignore raiz).
- Não desabilitar lint pra fazer passar — corrigir o erro.

## Publicação

部署流程和 Docker 运行事实统一维护在
[`../docs/deployment-self-hosted.md`](../docs/deployment-self-hosted.md)，本文件不重复维护部署细节。

## Desenvolvimento direto

O subprojeto pode ser ajustado diretamente no branch atual. Antes de entregar,
execute `pnpm lint`, as verificações específicas da mudança e `pnpm build` quando
a alteração afetar o bundle de produção.
