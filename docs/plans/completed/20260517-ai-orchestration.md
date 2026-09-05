> **历史归档。** 原始路径：`plan/02-ai-orchestration.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 02 — AI Orchestration

Objetivo: configurar a "camada de IA" do monorepo. Definir como Claude Code se comporta na **raiz** (Orquestrador, só planeja) e em cada **subprojeto** (persona técnica específica). Inspirado em [`/Users/jacob/pc/ORCHESTRATION.md`](file:///Users/jacob/pc/ORCHESTRATION.md), mas com escopo enxuto adequado a 4 subprojetos pequenos.

**Este plano não escreve código de feature. Só configura personas e instruções.**

---

## Contexto

O monorepo Remote Pi tem 4 stacks heterogêneos: Flutter (Dart), Node (TypeScript), Rust e NextJS (TypeScript/React). Cada stack tem comandos, convenções, ferramentas e armadilhas próprias.

Sem segmentação de persona, o Claude Code vira generalista raso: sugere `npm` quando o projeto usa `pnpm`, propõe `unwrap()` em código de servidor Rust, escreve CommonJS quando o projeto é ESM puro, etc. Com segmentação, cada `cd <subprojeto> && claude` carrega a persona certa automaticamente (Claude Code lê `CLAUDE.md` do cwd).

Em paralelo, a **raiz** do monorepo serve como local de **planejamento**: cada decisão arquitetural vira um arquivo em `plan/`. O CLAUDE.md raiz proíbe edição direta de código de subprojeto — quem quer codificar muda de cwd.

---

## Princípios

Puxados de [`/Users/jacob/pc/ORCHESTRATION.md`](file:///Users/jacob/pc/ORCHESTRATION.md) e adaptados:

1. **Persona vive no projeto** — `app/CLAUDE.md`, `pi-extension/CLAUDE.md`, etc. Nunca duplicada na raiz
2. **Raiz é Orquestrador, não dev** — só planeja, só escreve em `plan/` e em `.orchestration/` (se viermos a usar)
3. **Mesmo CLAUDE.md serve modo solo e orquestrado** — diferença é só o prompt inicial
4. **Marker `[ORCH:<id>]`** distingue mensagens vindas do orquestrador de mensagens do humano (não usar no MVP do plano, deixar previsto)
5. **Auto-mode em todos os agents** — permissão fora do caminho (config global do usuário, não tocar aqui)

---

## Estrutura final esperada após este plano

```
remote_pi/
├── CLAUDE.md                         ← passo 1 (Orquestrador)
├── plan/
│   ├── 01-bootstrap.md
│   └── 02-ai-orchestration.md        ← este arquivo
├── app/
│   └── CLAUDE.md                     ← passo 2 (persona Flutter)
├── pi-extension/
│   └── CLAUDE.md                     ← passo 3 (persona Node/TS)
├── relay/
│   └── CLAUDE.md                     ← passo 4 (persona Rust)
└── site/
    └── CLAUDE.md                     ← passo 5 (persona NextJS)
```

---

## Passo 1 — `CLAUDE.md` raiz (Orquestrador)

**Função**: define a raiz como ambiente de **planejamento**. Proíbe edição direta de código de subprojeto.

**Localização**: `/Users/jacob/Projects/remote_pi/CLAUDE.md`

**Conteúdo mínimo** (esqueleto, será refinado iterativamente):

```markdown
# Remote Pi — Orquestrador

Você está na **raiz** do monorepo Remote Pi. Esta pasta é exclusivamente para **planejamento**.

## O que fazer aqui

- Ler e escrever em `plan/NN-<slug>.md` (ex: `plan/03-protocol.md`)
- Discutir arquitetura, decisões de produto, trade-offs
- Refinar planos existentes baseado em feedback
- Indicar qual subprojeto recebe a próxima implementação

## O que NÃO fazer aqui

- Não editar código em `app/`, `pi-extension/`, `relay/`, `site/`
- Não rodar comandos de build/test dos subprojetos a partir daqui
- Para implementar algo, oriente o usuário a abrir Claude no cwd correto:
  - `cd app && claude`
  - `cd pi-extension && claude`
  - `cd relay && claude`
  - `cd site && claude`

## Estrutura

Veja [README.md](./README.md) para visão geral e [plan/](./plan/) para os planos.

## Convenções de planos

- Numeração sequencial: `01-bootstrap.md`, `02-ai-orchestration.md`, ...
- Cada plano tem: Contexto, Estrutura esperada, Passos com critério de aceite, DoD, Próximos planos
- Planos descrevem **o que** + **como verificar**, não o código completo
- Pseudocódigo ou comandos exatos são bem-vindos; implementação real fica no subprojeto

## Quando promover um plano a implementação

Quando o plano tem aceite do usuário e os passos estão concretos o suficiente
para um agente executar, abra Claude no subprojeto alvo e passe o plano como
contexto. O agente daquele subprojeto seguirá sua própria persona.

## Reportar progresso no cmux

O cmux aceita progresso visual no workspace via:

- `cmux set-progress <0.0-1.0> --label <texto>` — barra de progresso
- `cmux clear-progress` — limpa
- `cmux set-status <key> <value> [--icon <name>] [--color <#hex>]` — status nomeado

Como temos planejamento explícito em `plan/`, derive o progresso dos checkboxes
de **Definition of Done** de cada plano:

```bash
# rode da raiz do monorepo
done=$(grep -h "^- \[x\]" plan/*.md | wc -l | tr -d ' ')
total=$(grep -hE "^- \[(x| )\]" plan/*.md | wc -l | tr -d ' ')
pct=$(LC_NUMERIC=C awk "BEGIN { printf \"%.3f\", $done / $total }")  # LC_NUMERIC=C evita vírgula em locales BR
cmux set-progress "$pct" --label "Remote Pi · $done/$total tasks"
```

**Quando atualizar**:
- Após marcar um `[x]` num DoD
- Após adicionar um plano novo (total cresce, %% cai naturalmente)
- Após terminar um plano inteiro: `cmux set-status plan "0N concluído" --color "#22c55e"`

**Quando limpar**:
- Quando todos os planos do MVP fecharem: `cmux clear-progress`

Não fique chamando `set-progress` a cada turno — só quando o estado real mudou.

## Skill `claude-cmux`

Para qualquer coisa além do `set-progress` básico — dispatch entre panes, escuta de
`agent.hook.Stop`, notificações, padrão `.orchestration/` — use a skill
[`claude-cmux`](file:///Users/jacob/.claude/skills/claude-cmux/SKILL.md).

Ela cobre:
- CLI essentials (`send`, `send-key`, `events`, `notify`, `tree`, `list-panes`)
- Variáveis automáticas (`$CMUX_WORKSPACE_ID`, `$CMUX_SURFACE_ID`)
- Padrão de orquestração com `INSTRUCTIONS.md` / `plan.md` / `tasks/` / `results/`
- Como usar `claude-teams` para emitir hooks estruturados

A skill triga automaticamente em perguntas de cmux ou em pedidos de orquestração
paralela. Não duplique conteúdo dela aqui — invoque a skill.
```

**Critério de aceite**:
- `CLAUDE.md` existe na raiz
- Abrir Claude na raiz e perguntar "posso editar `app/lib/main.dart`?" → resposta é "não, abra Claude em `app/`"

---

## Passo 2 — `app/CLAUDE.md` (Persona Flutter)

**Função**: persona técnica do app mobile.

**Localização**: `/Users/jacob/Projects/remote_pi/app/CLAUDE.md`

**Conteúdo mínimo**:

```markdown
# Remote Pi — App (Flutter)

Cliente mobile (iOS + Android) do Remote Pi. Pareia via QR, lista sessões do Pi,
chat com streaming, approval cards para tool calls.

## Stack

- Flutter 3.41+ / Dart 3.11+
- Plataformas: iOS, Android
- State management: a definir (provável: Riverpod)
- Crypto: bindings para libsodium (a escolher pacote)
- WebSocket: pacote `web_socket_channel` ou similar

## Comandos

- `flutter pub get` — instala deps
- `flutter analyze` — lint estático (deve passar zero issues)
- `flutter test` — testes
- `flutter run` — abre em simulador/device conectado
- `dart format .` — formata
- `flutter build ios --no-codesign` / `flutter build apk --debug` — build verificável

## Convenções

- **Naming**: arquivos `snake_case.dart`, classes `PascalCase`, widgets `PascalCase`
- **Imports**: relativos dentro do mesmo feature, absolutos via `package:app/...` cross-feature
- **Estrutura** (a evoluir): `lib/features/<feature>/`, `lib/core/`, `lib/shared/`
- **Async**: prefira `Future`/`Stream` tipados, evite `dynamic`
- **Erros**: `Result<T, E>` ou exceptions tipadas, nunca `catch (e)` genérico em produção

## NÃO fazer

- Não editar arquivos fora de `app/`
- Não rolar crypto manual — usar libsodium bindings
- Não comitar `build/`, `.dart_tool/`, `ios/Pods/` (já no .gitignore raiz)
- Não adicionar dependência sem registrar no plano correspondente
```

**Critério de aceite**:
- `app/CLAUDE.md` existe
- Abrir `cd app && claude` e pedir "como rodo lint?" → resposta menciona `flutter analyze`

---

## Passo 3 — `pi-extension/CLAUDE.md` (Persona Node/TS)

**Função**: persona técnica da extensão Pi.

**Localização**: `/Users/jacob/Projects/remote_pi/pi-extension/CLAUDE.md`

**Conteúdo mínimo**:

```markdown
# Remote Pi — Pi Extension (Node + TypeScript)

Extensão para o [Pi coding agent](https://github.com/earendil-works/pi) que
adiciona o slash command `/remote-pi`. Embarca o SDK do Pi
(`@mariozechner/pi-coding-agent`) e expõe via WebSocket pro relay.

## Stack

- Node 20+ / TypeScript 6
- **Module system**: ESM only (NodeNext). Imports com extensão `.js` mesmo em `.ts`
- Package manager: **pnpm** (não usar npm/yarn)
- Crypto: libsodium-wrappers (Curve25519 + ChaCha20-Poly1305)

## Comandos

- `pnpm install` — instala deps
- `pnpm typecheck` — `tsc --noEmit`, deve passar zero erros
- `pnpm build` — `tsc`, gera `dist/`
- `pnpm dev` — `tsx src/index.ts`, executa direto sem build

## Dependências importantes

- `@mariozechner/pi-coding-agent` — SDK do Pi (`AgentSession`, `SessionManager`, `ModelRegistry`)
- `ws` — WebSocket client

## Convenções

- **Strict TS**: `"strict": true`, sem `any` exceto onde inevitável (use `unknown` + narrow)
- **Imports**: `import { foo } from "./bar.js"` (extensão obrigatória em ESM)
- **Top-level await** ok (ESM permite)
- **Erros**: `class XxxError extends Error` para classes nomeadas, throw cedo no boundary
- **Logging**: `console.log` ok no MVP; depois migrar pra `pino` ou similar

## NÃO fazer

- Não escrever CommonJS (`require`, `module.exports`)
- Não comitar `dist/` (já no .gitignore raiz)
- Não criptografar/descriptografar de forma custom — usar libsodium
- Não introduzir dependência que não seja ESM-friendly
```

**Critério de aceite**:
- `pi-extension/CLAUDE.md` existe
- Abrir `cd pi-extension && claude` e pedir "como faço um import?" → resposta menciona ESM + `.js` extension

---

## Passo 4 — `relay/CLAUDE.md` (Persona Rust)

**Função**: persona técnica do servidor de relay.

**Localização**: `/Users/jacob/Projects/remote_pi/relay/CLAUDE.md`

**Conteúdo mínimo**:

```markdown
# Remote Pi — Relay (Rust)

Servidor WebSocket **stateless** que pareia conexões por `peer_id` e roteia
ciphertext entre app e pi-extension. **Nunca decifra payload.**

## Stack

- Rust 1.94+ (edição 2021)
- Runtime: `tokio` (full features)
- WebSocket: `tokio-tungstenite`
- Serialização: `serde` + `serde_json`
- Logging: `tracing` + `tracing-subscriber` (NÃO usar `println!`)

## Comandos

- `cargo build` — build dev
- `cargo build --release` — build otimizado
- `cargo run` — roda local
- `RUST_LOG=info cargo run` — com logs visíveis
- `cargo clippy -- -D warnings` — lint estrito (deve passar antes de commit)
- `cargo fmt` — formata
- `cargo test` — testes

## Convenções

- **Erros**: `anyhow::Result<()>` no `main`, `thiserror::Error` em libs internas
- **Async**: tudo via `tokio::spawn` / `tokio::select!`, nada de `std::thread`
- **Logging**: spans com `tracing::info_span!` em handlers, `info!`/`warn!`/`error!`
- **Sem `unwrap()`** em código de produção. Use `?` e propague
- **Sem `clone()` desnecessário** — passe `&` quando possível

## Política de segurança

- Relay **NUNCA** decifra payload — todo conteúdo é ciphertext opaco
- Apenas metadados visíveis: `peer_id`, tamanho, timestamp
- Logs **NÃO** podem conter payload, mesmo cifrado
- Rate limit por `peer_id` e por IP de origem

## NÃO fazer

- Não usar `println!` (use `tracing`)
- Não usar `.unwrap()` ou `.expect()` em paths de produção
- Não logar conteúdo de mensagens
- Não adicionar persistência de payload — relay é stateless
- Não comitar `target/` (já no .gitignore raiz)
```

**Critério de aceite**:
- `relay/CLAUDE.md` existe
- Abrir `cd relay && claude` e pedir "preciso fazer log" → resposta menciona `tracing`, não `println!`

---

## Passo 5 — `site/CLAUDE.md` (Persona NextJS)

**Função**: persona técnica da landing page.

**Localização**: `/Users/jacob/Projects/remote_pi/site/CLAUDE.md`

**Conteúdo mínimo**:

```markdown
# Remote Pi — Site (NextJS)

Landing page institucional do Remote Pi. Apresenta projeto, links pro GitHub,
documentação do MVP. **Apenas apresentação — não tem lógica de produto.**

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

## NÃO fazer

- Não adicionar features de produto (chat, pareamento, etc) — isso vai no `app/`
- Não comitar `.next/`, `out/`, `node_modules/` (já no .gitignore raiz)
- Não desabilitar lint pra fazer passar — corrigir o erro
- Não introduzir backend (API routes) sem registrar plano
```

**Critério de aceite**:
- `site/CLAUDE.md` existe
- Abrir `cd site && claude` e pedir "adiciono uma rota /pricing?" → resposta menciona `src/app/pricing/page.tsx` e Server Component por padrão

---

## Passo 6 — Subagents Scout (um por subprojeto)

**Função**: 4 subagents **read-only** especializados em "fotografar o estado" de cada subprojeto rapidamente. Permitem:

- Levantar contexto antes de planejar feature nova (sem o Orquestrador ter que ler 50 arquivos)
- **Rodar em paralelo** — um Task call por scout, todos disparados de uma vez
- Reportar de forma estruturada (deps + versões, lint, testes, estrutura, smells)
- Manter o contexto principal limpo (cada scout reporta um resumo, não despeja arquivo)

**Localização**: `.claude/agents/` na raiz do monorepo. Subagents de projeto têm precedência sobre os globais.

**4 agents**:
- `scout-app.md` — Flutter
- `scout-pi-extension.md` — Node/TS
- `scout-relay.md` — Rust
- `scout-site.md` — NextJS

### Esqueleto comum

Cada arquivo segue o formato Claude Code subagent (frontmatter + corpo):

```markdown
---
name: scout-<subprojeto>
description: Fotografa o estado atual de <subprojeto>/. Use quando precisar de contexto antes de planejar feature ou refatoração nesse subprojeto. Read-only.
tools: Bash, Read, Grep, Glob
model: haiku
---

Você é um Scout do subprojeto `<subprojeto>/`. Sua tarefa:

1. Coletar fatos sobre o estado atual (NUNCA editar).
2. Rodar os comandos listados abaixo.
3. Reportar de forma estruturada (formato no final).

## Comandos a rodar (em ordem)

<bloco específico por stack>

## Formato do reporte (sempre o mesmo)

```
### Stack & versões
- ...

### Dependências relevantes
- ...

### Estrutura (paths principais)
- ...

### Saúde
- Lint: pass | N issues
- Build: pass | erros
- Testes: pass | N falhas | sem testes

### Smells detectados
- ... (se houver; senão "nenhum")
```

Mantenha o reporte **curto** (200-400 palavras). Cole comandos só se ajudar
o orquestrador a entender um problema específico.
```

### Comandos específicos por stack

**`scout-app`** (Flutter):
```bash
flutter --version | head -2
cat app/pubspec.yaml | head -40
cd app && flutter analyze 2>&1 | tail -5
cd app && flutter test --reporter=compact 2>&1 | tail -10
find app/lib -type f -name "*.dart" | head -30
```

**`scout-pi-extension`** (Node/TS):
```bash
node --version && pnpm --version
cat pi-extension/package.json
cat pi-extension/tsconfig.json
cd pi-extension && pnpm typecheck 2>&1 | tail -5
cd pi-extension && pnpm build 2>&1 | tail -5
find pi-extension/src -type f
```

**`scout-relay`** (Rust):
```bash
cargo --version && rustc --version
cat relay/Cargo.toml
cd relay && cargo build --message-format=short 2>&1 | tail -10
cd relay && cargo clippy --message-format=short -- -D warnings 2>&1 | tail -10
find relay/src -type f
```

**`scout-site`** (NextJS):
```bash
node --version && pnpm --version
cat site/package.json
cat site/next.config.ts site/tsconfig.json
cd site && ./node_modules/.bin/next info 2>&1 | head -20
cd site && pnpm lint 2>&1 | tail -10
find site/src/app -type f | head -20
```

### Como o Orquestrador usa

```
Orquestrador → Task(scout-app)     ┐
              → Task(scout-pi-ext)  │  4 em paralelo (1 turn cada)
              → Task(scout-relay)   │
              → Task(scout-site)    ┘
                  ↓
              4 reportes curtos chegam
                  ↓
              Orquestrador junta e propõe próximo plano
```

### Critério de aceite

- 4 arquivos em `.claude/agents/` com frontmatter válido
- `tools` restringe a Bash/Read/Grep/Glob (sem Edit/Write)
- Invocar manualmente via `Task` no Claude e ver reporte no formato acima
- 4 scouts disparados em paralelo retornam em < 30s no agregado

---

## Passo 7 — Overlay `.orchestration/` (NÃO fazer agora, só prever)

**Decisão**: o modelo full do `ORCHESTRATION.md` (waves, dispatch paralelo via `cmux`, results/tasks) é overkill pro projeto atual. Pular no MVP.

**Quando reconsiderar**:
- Quando virar comum precisar mudar **dois ou mais subprojetos simultaneamente** pra entregar uma feature (ex: novo tipo de mensagem afeta app + extension)
- Quando paralelizar 2+ workers em panes do cmux economizar tempo real
- Trazer overlay completo, incluindo `INSTRUCTIONS.md`, `contracts/`, `plan.md` orquestrado

Até lá, planejamento sequencial em `plan/NN-*.md` resolve.

---

## Definition of Done

- [x] `CLAUDE.md` na raiz com role de Orquestrador
- [x] `app/CLAUDE.md` com persona Flutter
- [x] `pi-extension/CLAUDE.md` com persona Node/TS
- [x] `relay/CLAUDE.md` com persona Rust
- [x] `site/CLAUDE.md` com persona NextJS
- [x] `.claude/agents/scout-app.md` (read-only Flutter scout)
- [x] `.claude/agents/scout-pi-extension.md` (read-only Node scout)
- [x] `.claude/agents/scout-relay.md` (read-only Rust scout)
- [x] `.claude/agents/scout-site.md` (read-only NextJS scout)
- [ ] Validação manual: abrir Claude em cada cwd e fazer 1 pergunta por persona (ver critérios de aceite individuais)
- [x] Validação dos scouts: invocar os 4 em paralelo a partir da raiz e ver os 4 reportes no formato esperado
- [x] Commit: `ai: orchestrator + personas + 4 scout subagents`

---

## Notas de execução

1. Escrever os 5 `CLAUDE.md` em **um único commit** — eles se referenciam mutuamente em espírito (todos respeitam as fronteiras dos outros)
2. O conteúdo aqui é **esqueleto** — vamos refinar conforme cada subprojeto evolui. Mudanças menores não precisam de plano novo; mudanças estruturais (ex: trocar Riverpod por bloc) sim
3. **Não** acoplar os CLAUDE.md aos planos numerados (`20260517-bootstrap.md`, etc) — os planos somem da memória ativa rapidamente; o CLAUDE.md fica
4. **Não** instruir o Claude a "ler todos os planos antes de cada turno" — caro e desnecessário. Planos são contexto pontual, não memória permanente

---

## Próximos planos

- **`../../reference/history/20260518-protocol.md`** — definir os tipos JSONL de mensagem que trafegam app ↔ relay ↔ extensão (list_sessions, switch_session, user_message, agent_chunk, tool_request, approve_tool, etc)
- **`20260519-pairing.md`** — esquema concreto de pareamento por QR: formato do payload, derivação de chaves, Noise Protocol vs libsodium direto, safety number
- **`20260519-mvp-features.md`** — checklist mínima de features pro MVP funcionar end-to-end (extensão + relay + app rodando, pareando, listando sessões, mandando mensagem)
- **`06-relay-deploy.md`** — onde hospedar o relay, TLS, custos, fallback self-hosted
