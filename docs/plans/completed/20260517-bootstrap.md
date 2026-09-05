> **历史归档。** 原始路径：`plan/01-bootstrap.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 01 — Bootstrap

Objetivo: criar a estrutura inicial do monorepo Remote Pi com os 4 subprojetos buildáveis (esqueleto, sem features) e o README raiz.

**Este plano não implementa features. Só esqueleto que compila/roda.**

---

## Contexto

Remote Pi é um sistema de **remote control** para sessões do [Pi coding agent](https://github.com/earendil-works/pi). Permite controlar sessões Pi locais a partir de um celular, usando uma extensão `/remote-pi` que faz pareamento via QR code, com **end-to-end encryption** ponta-a-ponta.

Arquitetura macro:

```
┌────────────┐       wss / E2E       ┌──────────┐       wss / E2E       ┌────────────────┐
│ App Flutter│ ◄───────────────────► │  Relay   │ ◄───────────────────► │  Pi extension  │
│ (iOS/Android)                       │ (Rust)   │                       │  (Node, /remote-pi)
└────────────┘                       └──────────┘                       └────────────────┘
                                                                                  │
                                                                          embarca SDK do Pi
                                                                          (AgentSession, etc.)
```

---

## Estrutura final esperada após este plano

```
remote_pi/
├── README.md                      ← passo 5
├── plan/
│   └── 01-bootstrap.md            ← este arquivo
├── app/                           ← Flutter (passo 1)
├── pi-extension/                  ← Node/TypeScript (passo 2)
├── relay/                         ← Rust (passo 3)
└── site/                          ← NextJS (passo 4)
```

---

## Pré-requisitos

Verificar antes de começar:

| Ferramenta | Como verificar | Como instalar |
|---|---|---|
| pnpm | `pnpm --version` | `npm i -g pnpm` |
| Rust (rustup) | `cargo --version` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |

---

## Passo 1 — Projeto Flutter (`app/`)

**Função no sistema**: app mobile que pareia via QR e mostra sessões do Pi.

**Comando**:
```bash
cd /Users/jacob/Projects/remote_pi
flutter create \
  --org dev.remotepi \
  --project-name app \
  --platforms=ios,android \
  app
```

**Estrutura mínima esperada**:
```
app/
├── pubspec.yaml
├── lib/
│   └── main.dart
├── ios/
└── android/
```

**Critério de aceite**:
- `app/pubspec.yaml` existe
- `cd app && flutter pub get` resolve sem erro
- `flutter analyze` passa zero issues
- `flutter run` abre o app default no simulador iOS ou Android (não precisa estar perfeito, só rodar)

---

## Passo 2 — Projeto Node (`pi-extension/`)

**Função no sistema**: extensão TypeScript que se instala no Pi coding agent e adiciona o slash command `/remote-pi`. Embarca o SDK do Pi (`@mariozechner/pi-coding-agent`) e expõe via WebSocket pro relay.

**Comandos**:
```bash
cd /Users/jacob/Projects/remote_pi
mkdir pi-extension && cd pi-extension

pnpm init
pnpm add -D typescript @types/node tsx
pnpm add @mariozechner/pi-coding-agent ws
pnpm add -D @types/ws

npx tsc --init \
  --target es2022 \
  --module nodenext \
  --moduleResolution nodenext \
  --strict \
  --outDir dist \
  --rootDir src \
  --esModuleInterop \
  --skipLibCheck

mkdir src
```

**Arquivo placeholder** `src/index.ts`:
```typescript
export function registerRemotePi(): void {
  console.log("[remote-pi] extension stub loaded");
}
```

**Adicionar em `package.json`**:
```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "dev": "tsx src/index.ts"
  }
}
```

**Critério de aceite**:
- `pnpm typecheck` passa sem erro
- `pnpm build` gera `dist/index.js`
- `pnpm dev` imprime `[remote-pi] extension stub loaded`

---

## Passo 3 — Projeto Rust (`relay/`)

**Função no sistema**: servidor WebSocket que pareia conexões pelo `peer_id` e roteia ciphertext entre app e pi-extension. **Stateless**, nunca decifra.

**Comandos**:
```bash
cd /Users/jacob/Projects/remote_pi
cargo new relay --bin
cd relay

cargo add tokio --features full
cargo add tokio-tungstenite
cargo add futures-util
cargo add serde --features derive
cargo add serde_json
cargo add tracing
cargo add tracing-subscriber --features env-filter
cargo add anyhow
```

**Placeholder** `src/main.rs`:
```rust
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    info!("relay listening on 0.0.0.0:3000 (stub)");
    Ok(())
}
```

**Critério de aceite**:
- `cargo build` passa sem warning crítico
- `cargo run` imprime a linha `relay listening on 0.0.0.0:3000 (stub)`
- `cargo clippy -- -D warnings` passa

---

## Passo 4 — Site NextJS (`site/`)

**Função no sistema**: landing page / cartão de visita. Apresenta o projeto, links pra GitHub, eventual download do app.

**Comando**:
```bash
cd /Users/jacob/Projects/remote_pi
pnpm create next-app@latest site \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --use-pnpm \
  --import-alias "@/*"
```

**Critério de aceite**:
- `cd site && pnpm dev` sobe em http://localhost:3000
- Landing page default do NextJS renderiza sem erro no console

---

## Passo 5 — README.md raiz

**Função**: documento explicativo na raiz do monorepo. Primeiro contato pra quem clona o repo.

**Conteúdo mínimo** (`/Users/jacob/Projects/remote_pi/README.md`):

```markdown
# Remote Pi

Remote control para sessões do [Pi coding agent](https://github.com/earendil-works/pi).

Controle sessões Pi locais a partir do celular via QR code, com end-to-end encryption.

## Por quê

O Pi é o concorrente open source mais relevante do Claude Code. Ele já tem
RPC mode, SDK público e sessões persistentes em JSONL — mas falta uma forma
boa de usar do celular. Remote Pi preenche esse gap, no estilo do que a
Anthropic fez com o Claude Code Remote Control oficial, mas para o Pi.

## Arquitetura

```
App Flutter ──wss/E2E──► Relay (Rust) ◄──wss/E2E── Pi extension (Node)
                                                          │
                                                  Pi process local
```

- **Pareamento** via QR code, persiste em Keychain (celular) e `~/.pi/remote/` (Mac)
- **E2E encryption** com Curve25519 + ChaCha20-Poly1305 (libsodium / Noise)
- **Relay nunca lê plaintext** — só roteia ciphertext
- **Forward secrecy**: ECDH efêmero a cada reconexão

## Pacotes

| Pacote | Stack | Função |
|---|---|---|
| `app/` | Flutter (iOS/Android) | Cliente mobile |
| `pi-extension/` | Node + TypeScript | Extensão Pi com `/remote-pi` |
| `relay/` | Rust + Tokio | Servidor WebSocket stateless |
| `site/` | NextJS | Landing page |

## Status

Em fase de bootstrap. Acompanhe em [`plan/`](./plan).

## Licença

A definir.
```

**Critério de aceite**:
- `README.md` existe na raiz
- Renderiza bem no GitHub (tabela, blocos de código)

---

## Notas de execução

1. **Ordem dos passos é livre** — todos são independentes. Recomendo na ordem listada pra fechar capacidades incrementais (UI → core → infra → site → docs).
2. **Não escrever features** em nenhum projeto neste plano. Só esqueleto buildável.
3. **Não configurar CI/CD** ainda. Vira plano próprio mais à frente.
4. **Não inicializar git** automaticamente — fazer 1 vez na raiz após terminar todos os passos: `cd /Users/jacob/Projects/remote_pi && git init && git add -A && git commit -m "bootstrap: scaffold app/, pi-extension/, relay/, site/"`.
5. **`.gitignore` raiz** vai precisar agregar: `node_modules/`, `dist/`, `target/`, `.next/`, `build/`, `.dart_tool/`, `ios/Pods/`, etc. Pode ser criado num refinamento depois ou junto do commit inicial.

---

## Definition of Done deste plano

- [x] `app/` existe e `flutter run` abre o app default
- [x] `pi-extension/` existe e `pnpm typecheck && pnpm build` passa
- [x] `relay/` existe e `cargo run` imprime stub
- [x] `site/` existe e `pnpm dev` serve a landing
- [x] `README.md` existe na raiz com as seções listadas
- [x] Commit inicial criado: "bootstrap: scaffold app/, pi-extension/, relay/, site/"

---

## Próximos planos (não fazer aqui)

- **`20260517-ai-orchestration.md`** — CLAUDE.md raiz como **Orquestrador** (modelo do [`/Users/jacob/pc/ORCHESTRATION.md`](file:///Users/jacob/pc/ORCHESTRATION.md)) que só planeja e escreve em `plan/`. CLAUDE.md específico para cada subprojeto (persona Flutter, persona Node/TS, persona Rust, persona NextJS). Subagents customizados se necessário. Possível overlay `.orchestration/` com contracts cross-project.
- **`../../reference/history/20260518-protocol.md`** — definição dos tipos de mensagem JSONL trocados app ↔ relay ↔ extensão.
- **`20260519-pairing.md`** — esquema concreto de QR + E2E (Noise vs libsodium direto, formato do QR, safety number).
- **`20260519-mvp-features.md`** — checklist mínima de features pro MVP (list sessions, chat, approvals, switch session).
