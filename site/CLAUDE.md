# Remote Pi — Site (NextJS)

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
- Não reintroduza landing page, documentação pública ou páginas legais no Site; a
  interface de produto permanece exclusivamente em `/app`.
- Não adicionar backend ou API routes sem autorização explícita.
- Não comitar `.next/`, `out/`, `node_modules/` (já no .gitignore raiz).
- Não desabilitar lint pra fazer passar — corrigir o erro.

## Publicação (deploy)

O site roda em produção (`remote-pi.jacobmoura.work`) como **imagem Docker** no
Docker Hub: `jacobmoura7/remote-pi-site`. O host de produção puxa a tag
`:latest` — então **publicar = buildar e dar push da imagem**.

```bash
./push-docker.sh            # build multi-plataforma + push, tag :latest
./push-docker.sh v1.2.3     # tag :v1.2.3 E :latest
```

O que o script faz: cria (idempotente) um builder buildx `multiarch`
(`docker-container`), builda para `linux/amd64,linux/arm64` a partir do
`Dockerfile` (multi-stage → `next build` com `output: "standalone"`, runtime
`node:22-alpine` na porta 3000 com healthcheck em `/`) e dá `--push` pro Docker
Hub.

Pré-requisitos: **`docker login`** (Docker Hub) feito antes, e `docker buildx`
(vem no Docker moderno). Sem login, o push falha no fim do build.

Fluxo típico de publicação: commit + push no git → `pnpm lint && pnpm build`
verdes → `./push-docker.sh` → o host redeploya da `:latest`. Passe uma versão
(`vX.Y.Z`) quando quiser uma tag fixada além da `:latest`.

O teste isolado do PWA usa o script da raiz:

```bash
scripts/deploy-self-hosted.sh test
```

Ele constrói e transfere as imagens, inicia apenas o PWA de teste e mantém a
instância de produção inalterada.

## Desenvolvimento direto

O subprojeto pode ser ajustado diretamente no branch atual. Antes de entregar,
execute `pnpm lint`, as verificações específicas da mudança e `pnpm build` quando
a alteração afetar o bundle de produção.
