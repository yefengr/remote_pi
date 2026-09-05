> **历史归档。** 原始路径：`plan/27-pre-publish-cycle.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 27 — Ciclo de fechamento pré-publish

Objetivo: fechar 4 etapas de polish que ainda separam Remote Pi do primeiro round de testes pesados pré-publish. Nenhuma é feature nova; tudo é refinamento sobre a fundação já entregue (plans 23+24+25).

**Status (2026-05-24)**: esqueleto inicial. Wave B em **decisão pendente** (entrevista em curso). Demais waves prontas pra execução.

---

## Wave A — Pareamento polish no mobile

**Status**: pronto pra despachar.

- Após pareamento bem-sucedido, app pede ao usuário **nick** pro PC pareado (não ficar "Pi" genérico)
- App **mostra harness** que aquele PC está rodando — hoje sempre `Pi coding agent`; futuro abrirá pra Claude Code, OpenCode via MCP no mesmo protocolo
- Harness vem do pi-extension via `pair_ok` (novo campo `harness: {name, version}` no payload)
- Persiste no PairingStorage; reflete na Home (PiCard ou similar)

**Toca**: `app/lib/ui/pairing/`, `app/lib/data/pairing/`, `pi-extension/src/index.ts` (no `_handlePairRequest`/`pair_ok`)

**DoD**:
- [ ] Após pair, modal pede nick; nick obrigatório (fallback default "Pi" se skip)
- [ ] PiCard mostra label "via Pi coding agent" (ou outro futuro harness)
- [ ] mesh_versions reflete o nick atualizado (publish ao salvar)
- [ ] `flutter test` cobre input do nick + display do harness

---

## Wave B — Decisão: relay via UDS local

**Status**: ✅ **decisão fechada 2026-05-24** — broker-gateway DESCARTADO. Caminho alternativo via wrappers.

### Decisões da entrevista (registradas)

- **P1 — Identidade Ed25519**: Opção A (1 PC = 1 Pi-key; ssh-agent pattern) confirmada como direção, mas NÃO exige broker-gateway agora
- **P2 — Motivo único do broker-gateway**: onboarding de novos harnesses (Claude Code, OpenCode via MCP) com eleição entre eles
- **P3 — Latência endereçada**: UDS ~10-50µs vs WS pro relay 1-50ms vs cross-PC 100ms+. UDS hop é <0.1% overhead, estatisticamente invisível. NÃO é problema real

### Decisão final: wrappers em vez de broker-gateway

Em vez de refactor do pi-extension pra virar broker-gateway centralizado, suporte futuro a novos harnesses fica via **wrappers**:

```
remote-pi pi          → pi-extension hoje (hosta broker UDS + WS pro relay)
remote-pi claude      → wrapper spawn claude code + registra como peer UDS no broker
remote-pi opencode    → idem pra opencode
remote-pi <harness>   → padrão extensível por wrapper script
```

Cada wrapper:
1. Conecta no broker UDS local existente como peer (nome do harness)
2. Spawn do harness real (stdio/API/MCP)
3. Traduz envelope JSONL ↔ dialeto do harness
4. Standalone-friendly: se broker offline, harness roda direto sem mesh

### Por que wrappers > broker-gateway

| Critério | Broker-gateway | Wrappers |
|---|---|---|
| Refactor pi-extension | Grande | Zero |
| Pi-key custódia | Move pra novo daemon | Continua na pi-extension/Keychain |
| Hard dep entre processos | Sim (broker SPOF) | Não (wrapper roda standalone) |
| Versionamento protocolo | API broker↔agente nova | Reusa envelope JSONL existente |
| Onboarding harness | MCP spec + plugin discovery | 1 wrapper script |
| Eleição entre harnesses | Sim, infra nova | Já existe no broker (leader_election.ts) |
| Isolável | Não | Sim (deletar wrapper = remover suporte) |

### Não-objetivos desta decisão

- **Não implementa wrappers agora** — fica como direção arquitetural pra quando demanda concreta surgir (algum usuário pedindo Claude Code no mesh)
- **Não vira plan/28** ainda — só registra decisão. Plan/28 nasce com motivação real
- **Pi-extension permanece monolito** (sessão Pi + broker host + WS pro relay). Aceitável: é o caso de uso primário
- **MCP plugin spec** fica pra explorar quando wrapper de Claude Code começar — não vale especular formato hoje

---

## Wave C — Atualizar docs/reference/history/20260518-protocol.md

**Status**: pronto pra despachar (refresh de docs, não código).

`docs/reference/history/20260518-protocol.md` foi escrito antes de:
- ACK protocol event-driven (received|busy|denied) — plan/25 Wave 0
- Cross-PC envelope routing (`pi_envelope` / `pi_envelope_in`) — plan/25 Wave A
- Prefix `<pc>:<peer>` no naming — plan/25 Wave C
- `transport_error` como envelope vs erro WS custom — plan/25 ACK protocol
- mesh_versions assinada (Ed25519) — plan/24
- broker_remote + injectFromRemote — plan/25 Wave B

Atualização in-place do plan/03, sem renumerar. Adicionar seções "ACK", "Cross-PC envelope routing", "Mesh membership". Marcar partes obsoletas com strikethrough + referência ao plano que substituiu.

**DoD**:
- [ ] Seções novas: ACK, Cross-PC, mesh_versions, broker_remote
- [ ] Trechos obsoletos com strikethrough + ref
- [ ] Exemplos de wire format atualizados

---

## Wave E — Pi-key hardening cross-platform

**Status**: pronto pra despachar.

**Contexto**: descoberto 2026-05-24 em revisão de segurança — a Pi-secret JÁ está no Keychain via `keytar` (não em `identity.json` em disco como inicialmente preocupado). MAS:
- `keytar` está deprecated (repo arquivado pelo Atom em 2022)
- Service name `dev.remotepi.mac` sugere que cross-platform nunca foi exercitado
- `peers.json` (metadata pública: Owner-pubkeys + nicks) ainda em disco sem `chmod`

### E1 — Migrar pra `@napi-rs/keyring` cross-platform

- Trocar `keytar` por `@napi-rs/keyring` (mantido, NAPI-RS native, mesma API conceitual)
- Renomear service `dev.remotepi.mac` → `dev.remotepi.pi` (neutro)
- Migration path: no boot, se keytar antigo tem entry, ler → regravar via napi-rs → deletar antigo
- Smoke test real:
  - macOS: Keychain (Apple Silicon delega pra SE transparente)
  - Linux desktop: libsecret (GNOME Keyring / KWallet)
  - Windows: Credential Manager (DPAPI-backed)
- **Headless Linux fallback**: detecta ausência de D-Bus session → arquivo `~/.pi/remote/identity.json` com `chmod 0o600` + warning loud no log (`PI_KEY_INSECURE_FALLBACK=true`)

### E2 — Hardening `peers.json` (privacy)

- `writeFile` com `mode: 0o600` no `peers.json`
- `mkdir` com `mode: 0o700` no `~/.pi/remote/`
- Atomic write: escrever em `peers.json.tmp` + `rename` (evita corrupção em race)
- **Nota**: peers.json é **só metadata pública** (Owner-pubkeys + nicks); vazamento é privacy, não impersonation. Mas hygiene básica

### E3 — Detecção de clone no relay (mitigação)

- Quando o relay recebe 2ª `register` com mesma Pi-pubkey vinda de IP diferente:
  - Log estruturado `tracing::warn!(peer=..., ip_a=..., ip_b=..., "possible clone")`
  - (Futuro) Push notification pro Owner-app via mesh_versions Owner-pubkey
- Não bloqueia (false positive: roaming wifi/4G, dual-NIC)
- Mudança pequena no `peers/registry.rs::register()`

### Constraint chave (decisão fechada 2026-05-24)

> "Não importa se essas chaves se perderem em uma troca de hardware. Queremos uma pro PC."

Implicação: **sem migration de Pi-key entre PCs**. Troca de Mac/Linux/Windows = nova Pi-pubkey, Owner re-pareia. Por isso **Fase 2 (HW puro via Secure Enclave / TPM / CNG) descartada** — o ganho marginal não justifica a complexidade cross-platform. Cobre 95% do threat model com Fase 1 (user-bound encrypted).

### Multi-pareamento já funciona

Pi-key é **uma só por PC**, imutável. Cada Owner adicional:
- Acrescenta entry em `peers.json` (1 por Owner)
- Adiciona Pi-pubkey no seu próprio `mesh_versions` no relay
- Pi-secret no Keychain **não muda**

Nenhuma multiplicação de secrets — apenas pubkeys de Owners agregadas em metadata.

### DoD Wave E

- [ ] E1: `@napi-rs/keyring` no lugar de `keytar`, smoke test em macOS + Linux + Windows
- [ ] E1: migration path do service antigo `dev.remotepi.mac` → `dev.remotepi.pi`
- [ ] E1: fallback headless documentado + warning
- [ ] E2: `peers.json` escrito com `0o600`; diretório com `0o700`; atomic write
- [ ] E3: log de clone detection no relay
- [ ] `pnpm test` + `pnpm typecheck` no pi-extension; `cargo test` no relay

---

## Wave D — Docs pi-extension + Site (mesh de agentes)

**Status**: pronto pra despachar.

- `pi-extension/CLAUDE.md` ainda fala "WebSocket pro relay" como se fosse fim em si. Atualizar pra refletir: agora somos **mesh de agentes** rodando em N PCs, falando via envelope unificado (UDS local + relay forward), com Owner-key cross-device, multi-Pi por Owner, harness pluggable (Pi hoje; Claude Code/OpenCode futuro)
- `site/` (landing + docs) precisa comunicar **mesh de agentes** como proposta de valor. Copy: "seus terminais conversam entre si; celular é só autenticador"

**Toca**: `pi-extension/CLAUDE.md`, `site/app/` (páginas), `site/components/`

**Constraint** (per memory `feedback_no_site_screenshots`): em `site/`, NÃO tirar screenshots; só `pnpm lint && pnpm build`

**DoD**:
- [ ] `pi-extension/CLAUDE.md` reflete mesh + multi-harness future
- [ ] Site copy atualizada (sem afirmar E2E — per memory `project_no_e2e_yet`)
- [ ] `pnpm lint && pnpm build` no site OK

---

## DoD consolidado

- [ ] Wave A entregue (pareamento polish)
- [x] Wave B fechada (broker-gateway DESCARTADO; caminho alternativo = wrappers, fica como direção arquitetural sem plan/28 ainda)
- [x] Wave C entregue (plan/03 atualizado 2026-05-24: header de alerta + seção "Mudanças pós-MVP" apontando pra PROTOCOL.md)
- [x] Wave D entregue parcial (Site 27-d + Extension README polish via 27-extension-combo + Relay README via 27-relay-readme + PROTOCOL.md canônico criado no raiz). **Pendente**: cleanup residual de 2 afirmações E2E no `pi-extension/README.md` (linhas 196-198 e 214) — sinalizado pelo agent, fica como wave curta `27-readme-e2e-cleanup`
- [ ] Wave E entregue (Pi-key hardening cross-platform)
- [ ] Memory `project_pre_publish_cycle` atualizada com status final
