> **历史归档。** 原始路径：`plan/11-session-sync.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 11 — Session sync (histórico via delta por timestamp)

## Contexto

App hoje começa cada chat vazio. Conversa anterior só fica visível
enquanto a conexão está aberta — fechou e reabriu, perdeu tudo
visualmente. Decidido em conversa (2026-05-20) que vale resolver isso
sem deixar pra "futuro" porque é dor concreta.

Decisão de modelo: **cache local + sync incremental por timestamp**
(padrão WhatsApp/Slack), com Pi sendo a fonte de verdade durante a
sessão ativa. Edge case de Pi restart resolvido via campo
`session_started_at` no `pair_ok` e `session_history` (opção B do
levantamento — app compara com último visto e limpa cache se mudou).

Persistência local no app é **cache descartável**: serve só pra render
rápido + visão "última conexão" quando offline. Pi continua sendo
autoritativo enquanto online; sync sempre traz delta posterior ao
último timestamp visto.

---

## Decisões fixadas

| Decisão | Valor / razão |
|---|---|
| **Storage no app** | `hive` (Flutter-native, key-value, escala bem, simples) particionado por `peer.remoteEpk` |
| **Tipo de timestamp** | `number` (epoch ms, igual ao `timestamp` do `@mariozechner/pi-ai`) |
| **`session_started_at`** | Epoch ms quando o Pi entrou no state `started` (ou seja, último `/remote-pi start`). Reset ao `/remote-pi stop`. Pi-ext mantém em variável module-level |
| **Detecção de reset** | App armazena último `session_started_at` visto por peer. Se chegou diferente, **descarta cache local daquele peer** e processa history como fresh |
| **Batching** | Pi quebra `session_history` em batches se passar 1 MiB do limite do envelope. Último batch tem `eos: true` |
| **Quem inicia sync** | `SessionRepository` ao adoptar/conectar channel (debounce 200ms pra evitar disparo múltiplo em race de connection lifecycle) |
| **Eventos sincronizados** | `user_input` (+ aliases pra user_message remoto), `agent_message` (texto consolidado, NÃO chunks), `tool_request`, `tool_result`. Sem chunks intermediários (só o texto final via `agent_message`) |

## Por que `agent_message` consolidado e não `agent_chunk`s

Cache local guarda só estado final. Replayar 200 chunks pra mostrar
uma resposta de 1 frase é desperdício. Pi consolida `AssistantMessage`
do SDK em 1 evento `agent_message` no history. Streaming em real-time
continua via `agent_chunk` quando uma resposta nova está sendo gerada.

---

## Novos types no protocolo

### App → Pi
```jsonc
{
  "type": "session_sync",
  "id": "<uuid>",
  "since_ts": 1716234567000,        // 0 ou null se primeira vez / cache descartado
  "session_started_at": 1716200000000  // null se primeira vez
}
```

### Pi → App (uma ou mais respostas; última tem `eos: true`)
```jsonc
{
  "type": "session_history",
  "in_reply_to": "<uuid>",
  "session_started_at": 1716234500000,  // sempre presente — app compara
  "events": [
    { "ts": 1716234600000, "type": "user_input", "id": "...", "text": "..." },
    { "ts": 1716234601000, "type": "tool_request", "tool_call_id": "...", "tool": "bash", "args": {...} },
    { "ts": 1716234603000, "type": "tool_result", "tool_call_id": "...", "result": "..." },
    { "ts": 1716234605000, "type": "agent_message", "in_reply_to": "...", "text": "resposta completa…", "usage": {...} }
  ],
  "eos": true
}
```

### Mudança no `pair_ok` (já existe, ganha campo)
```jsonc
{
  "type": "pair_ok",
  "in_reply_to": "<uuid>",
  "session_name": "...",
  "session_started_at": 1716234500000   // NOVO
}
```

### Tipo novo `agent_message` (server → app, usado apenas em history)
```jsonc
{ "type": "agent_message", "in_reply_to": "<id>", "text": "<consolidado>", "usage": {...} }
```

`agent_chunk`/`agent_done` continuam intactos pra streaming live. `agent_message` é só pra replay/history.

---

## Estrutura esperada

### Pi-extension
- Variável `_sessionStartedAt: number | null`, setada em `_cmdStart`, resetada em `_goIdle`
- Handler novo `case "session_sync"` em `routeClientMessage`:
  1. Lê `_pi.state.messages`
  2. Mapeia `Message[]` → eventos do contrato (UserMessage→user_input, AssistantMessage→agent_message, ToolResultMessage→tool_result; tool_request reconstruído dos `ToolCall` content blocks da AssistantMessage)
  3. Filtra `timestamp > since_ts` (se `since_ts` presente E `session_started_at === pi._sessionStartedAt`; senão manda tudo)
  4. Envia `session_history` (batches se total > 900 KB pra ficar bem abaixo do limite)
- `pair_ok` ganha `session_started_at`

### App
- `lib/data/repositories/session_history_store.dart` — wrapper sobre hive, API: `loadFor(epk) → List<ChatMessage> + lastTs + lastSessionStartedAt`, `appendFor(epk, events)`, `replaceFor(epk, events, sessionStartedAt)`, `clearFor(epk)`
- `SessionRepository` ganha:
  - Construtor recebe `SessionHistoryStore`
  - `boot/adopt` carrega local primeiro (`emit(state with cached messages)`)
  - Dispara `requestSync()` após channel pronto (200ms debounce)
  - Handler `case SessionHistory(:events, :sessionStartedAt, :eos)`:
    - Se `sessionStartedAt != lastSessionStartedAt salvo` → `store.replaceFor()` + reset state.messages
    - Senão → `store.appendFor()` + apenda em state.messages
  - Eventos cacheados ao chegarem em real-time também (UserMsg, AssistantMsg após AgentDone, ToolEvent.completed)
- `lib/protocol/protocol.dart` — classes novas: `SessionSync` (client), `SessionHistory` (server), `AgentMessage` (server, usado em history)
- `PairOk.fromJson` lê `session_started_at` opcional

### Relay
- **Zero mudança.** Tudo trafega no envelope existente.

---

## Passos com critério de aceite

### Wave 0 — Contratos (orquestrador-only)
- [ ] Atualizar `.orchestration/contracts/protocol.md` — adicionar `session_sync`, `session_history`, `agent_message`; atualizar `pair_ok` com `session_started_at`
- [ ] Atualizar `.orchestration/contracts/pairing.md` — mencionar `session_started_at` no shape do `pair_ok`
- [ ] Adicionar fixtures: `session_sync.jsonl`, `session_history.jsonl`, `agent_message.jsonl`
- [ ] Atualizar fixture `pair_ok.jsonl` com `session_started_at`

### Wave 1 — Subprojetos em paralelo
#### W1.A — pi-extension
- [ ] Adicionar `_sessionStartedAt` (set em `_cmdStart`, reset em `_goIdle`)
- [ ] Adicionar campo no `pair_ok` emit
- [ ] Adicionar `case "session_sync"` em `routeClientMessage` com filtragem + batching
- [ ] Mapeador `AgentMessage[] → ProtocolEvent[]` (extrair tool_request/result dos content blocks)
- [ ] Types novos em `src/protocol/types.ts` + codec
- [ ] Testes: sync vazio, sync com 3 eventos, sync após reset (session_started_at mudou)
- [ ] `pnpm typecheck && pnpm build && pnpm test` verde

#### W1.B — app
- [ ] Adicionar dep `hive_flutter` (ou `hive` + boot)
- [ ] Criar `SessionHistoryStore` com hive
- [ ] Atualizar `SessionRepository` (load local primeiro, request_sync após adopt, handler SessionHistory com reset/append)
- [ ] Cache real-time de eventos (AgentDone consolida streaming buffer + grava local)
- [ ] Atualizar `PairOk` em `protocol.dart` com `sessionStartedAt`
- [ ] Adicionar `SessionSync`, `SessionHistory`, `AgentMessage` em `protocol.dart`
- [ ] Inicializar hive em `main.dart` antes do runApp
- [ ] Testes: sync delta apenda, sync com session_started_at diferente substitui, real-time eventos vão pro cache
- [ ] `flutter analyze && flutter test` verde

### Wave 2 — Roundtrip manual
- [ ] Iniciar Pi, parear, mandar 3 mensagens → fechar app → reabrir → ver as 3 mensagens carregadas instantaneamente
- [ ] Mandar 1 mensagem nova no terminal Pi (via `pi.on("input", ...)` da 10.5) → app ainda fechado → reabrir app → ver a nova mensagem aparecer também (via sync delta)
- [ ] `/remote-pi stop` no Pi → `/remote-pi start` (session_started_at muda) → app reabre → cache antigo descartado, mostra sessão atual (vazia ou com novas msgs)
- [ ] App offline (kill WiFi) → reabre app → mostra cache local com tarja "última conexão: X"
- [ ] App online de volta → sync delta apenda novas msgs

---

## Definition of Done

- [x] Wave 0: contracts + 4 fixtures (pair_ok atualizado, session_sync/session_history/agent_message novos)
- [x] W1.A: pi-ext sync handler + session_started_at + testes (71 tests ✓, +8)
- [x] W1.B: app hive store + load-first + sync delta + reset detection + testes (100 tests ✓, +12)
- [ ] Wave 2: roundtrip manual 100% verde
- [ ] Atualizar `../../adr/20260518-closed-decisions.md` — registrar persistência via cache descartável (Opção C do levantamento)

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Sessão com 10k mensagens → 1ª sync > 1 MiB → > 1 batch | Batching já planejado; limite de 900KB por batch deixa folga |
| Hive corrompido após crash | Try/catch em `loadFor` → fallback pra cache vazio + log warning |
| `session_started_at` igual em 2 sessões diferentes (Pi reiniciou em < 1ms) | Improvável; aceitamos. Pode adicionar UUID em plano futuro se aparecer |
| `_pi.state.messages` muito grande consome RAM no mapping | Stream mapping (yield event a event) em vez de map.toArray() |
| App apenda no cache eventos out-of-order vindos do sync + real-time | App ordena por `ts` antes de emit; dedup por `id`/`tool_call_id` |
| User troca de peer com cache local → app esquece de carregar do novo peer | `SessionRepository.adopt(peer, channel)` chama `store.loadFor(peer.remoteEpk)` antes de emit inicial |

---

## Próximos planos

- **Plano 07** (relay deploy) — adiado pelo user
- **Plano 12** (potential) — caching/eviction policy se uso real mostrar storage crescendo demais
