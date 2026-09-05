> **历史归档。** 原始路径：`plan/16-mirror-cache.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 16 — Mirror cache (espelhar terminal, sync limitado)

## Contexto

Plano 11 implementou sync incremental: app salva cache hive + pede delta
via `since_ts`. Em uso real, isso causa drift:

- Mensagens enviadas no terminal Pi enquanto app estava offline podem
  ficar fora do cache do app
- Reset do Pi (session_started_at muda) invalida tudo, perde histórico
- Append-based cache pode divergir do estado real do Pi (compactação,
  edits internos)

Decisão (2026-05-21): **app espelha exatamente o que está no terminal Pi**.
Toda vez que conecta, baixa as últimas N mensagens, **substitui** o cache
local. Sai do modelo append/delta pra modelo mirror/snapshot.

## Decisões fixadas

| Decisão | Valor |
|---|---|
| **Modelo** | Mirror (snapshot completo das últimas N) — não delta |
| **Limite N** | 30 últimas mensagens por default |
| **Configurável** | Env var `REMOTE_PI_SYNC_LIMIT` no pi-ext (default 30) |
| **Sync triggers** | (a) ChatViewModel mount, (b) ConnectionManager StatusOnline transition após reconnect |
| **Cache local** | Hive — espelha exatamente as N últimas. Se Pi tem 5, cache fica com 5 (descarta antigas) |
| **Offline** | App mostra cache da última sync. Banner offline já existe |
| **`since_ts`** | **Removido** do request. Server sempre devolve últimas N |
| **`session_started_at`** | Mantido na resposta pra info diagnóstica. App ignora pra invalidação |
| **D1: UI da flag `truncated`** | **B — sem indicador** (user não percebe que há mais mensagens). Resposta carrega `truncated` mas UI ignora |
| **D2: Cache vs real-time race** | **A — aceitar trade-off**. Sync pode brevemente sobrescrever msg real-time recente; próximo sync corrige. MVP simples |

## Mudanças no protocolo

### `session_sync` simplificado

```jsonc
// Antes
{ "type": "session_sync", "id": "...", "since_ts": 1716234567000, "session_started_at": 1716200000000 }

// Depois
{ "type": "session_sync", "id": "...", "limit": 30 }
```

`limit` é o tamanho máximo desejado pelo cliente. Pi pode mandar menos (se não tem N) mas nunca mais. Padrão: 30 quando omitido.

### `session_history` simplificado

```jsonc
// Antes
{ "type": "session_history", "in_reply_to": "...", "session_started_at": <ts>, "events": [...], "eos": true }

// Depois (mesma forma, mas eventos sempre são os últimos N)
{ "type": "session_history", "in_reply_to": "...", "session_started_at": <ts>, "events": [...], "eos": true, "truncated": false }
```

- `events`: até `limit` últimas mensagens, em ordem cronológica
- `truncated`: true se Pi tem mais que `limit` (mostrar "..." no início do app)
- `session_started_at`: mantido pra logs/diagnóstico (não invalida cache)
- `eos`: sempre `true` no novo modelo (sem batching, max 30 events cabem em 1 frame de <100KB)

## Estrutura esperada

### Pi-extension

- `kSyncLimit = parseInt(process.env.REMOTE_PI_SYNC_LIMIT ?? '30')` no boot
- `_handleSessionSync(msg)`:
  ```typescript
  const limit = Math.min(msg.limit ?? kSyncLimit, kSyncLimit);  // app não pode pedir > env
  const allEvents = _mapAgentMessagesToEvents(_pi.state.messages);
  const slice = allEvents.slice(-limit);  // últimas N
  const truncated = allEvents.length > limit;
  _peerChannel.send({
    type: 'session_history',
    in_reply_to: msg.id,
    session_started_at: _sessionStartedAt,
    events: slice,
    eos: true,
    truncated,
  });
  ```
- Remover lógica de filtragem por `since_ts`
- Tests: limit honored, truncated flag correto, env var override

### App

- `SessionRepository.requestSync({int? limit})`:
  - Manda `{type: 'session_sync', id, limit: 30}` (default 30; sem `since_ts` nem `session_started_at`)
- `case SessionHistory(:events, :sessionStartedAt, :truncated)`:
  - **Sempre substitui** (não merge): `_emit(state.copyWith(messages: convertedEvents))`
  - `await _store.replaceFor(activeEpk, convertedEvents, sessionStartedAt, lastTs)`
  - Loga truncated pra debug
- Remover `_lastSyncedTs` (não usado mais)
- Remover `_lastSessionStartedAt` comparação (cache sempre substitui)
- `_onlineActivated` continua disparando `requestSync` no debounce 200ms (já existe)
- `ChatViewModel._bootstrap` continua disparando `requestSync` ao montar (já existe)
- `SessionHistoryStore`:
  - `replaceFor(epk, events, sessionStartedAt, lastTs)` — método já existe, usar exclusivamente
  - `appendEvents` pode ficar pra real-time, mas tests devem confirmar que mirror sync substitui depois
- **Real-time eventos ainda apendam** (não conflita): user_input, agent_done, tool_result vindos via push entram em cache enquanto chat ativo. Próximo sync substitui (espelha real). Trade-off conhecido: mensagem real-time pode "sumir" se sync chegar com lista de N que não inclui ela (improvável — Pi vê ela primeiro)
- Tests: sync replace, truncated flag, real-time + sync ordering

### Relay
- **Zero mudança.**

## Passos com critério de aceite

### Wave 0 — Contratos
- [ ] Atualizar `.orchestration/contracts/protocol.md`: `session_sync` ganha `limit`, perde `since_ts/session_started_at` no request. `session_history` ganha `truncated`. Atualizar fixtures
- [ ] Atualizar fixtures `session_sync.jsonl` e `session_history.jsonl`

### Wave 1 — Subprojetos em paralelo

#### W1.A — pi-extension
- [ ] `kSyncLimit` lido de env (default 30)
- [ ] `_handleSessionSync` reescrito: limita pelas últimas N, sempre eos:true, calcula truncated
- [ ] Tests: env var → limite, request com limit menor → menos events, truncated quando >N
- [ ] `pnpm typecheck && pnpm build && pnpm test` verde

#### W1.B — app
- [ ] `SessionSync` ganha `limit`, perde `sinceTs/sessionStartedAt` no request
- [ ] `SessionHistory` ganha `truncated`
- [ ] `SessionRepository.requestSync()` manda limit:30
- [ ] Handler `SessionHistory`: sempre `_store.replaceFor()` + `_emit(state.copyWith(messages: events))`
- [ ] Remover `_lastSyncedTs` + lógica de reset detection por sessionStartedAt
- [ ] Cache hive: load no setActivePeer continua (oferece read offline imediato)
- [ ] Tests: sync replace, truncated banner (opcional UI), offline cache visível
- [ ] `flutter analyze && flutter test` verde

#### W1.C — relay
- [ ] **Sem mudança.** Smoke `cargo test` verde.

### Wave 2 — Roundtrip manual
- [ ] Pi com 10 mensagens. App abre chat → sync traz 10
- [ ] Pi com 50 mensagens. App abre chat → sync traz 30 (truncated=true, banner opcional)
- [ ] App fechado, user manda 5 mensagens no terminal Pi. App abre → sync traz últimas 30 incluindo as 5 novas
- [ ] App online + terminal manda msg → real-time chega via push (agent_chunk/user_input)
- [ ] Pi `/remote-pi stop` + `/remote-pi start` (session_started_at muda) → app continua mostrando histórico cache até online; ao online, sync traz nova sessão (pode ser vazia, cache substitui)
- [ ] Offline (kill WiFi): app mostra cache da última sync com banner offline
- [ ] Online de volta: sync re-substitui cache

### Wave 3 — Polish
- [ ] Atualizar `../../adr/20260518-closed-decisions.md`: registrar mirror cache + limite 30
- [ ] Atualizar `pi-extension/CLAUDE.md`: mencionar `REMOTE_PI_SYNC_LIMIT` env var
- [ ] Commit

---

## Definition of Done

- [x] Wave 0: contracts + 2 fixtures atualizadas
- [x] W1.A: pi-ext mirror sync + env var + tests (95 tests, +4)
- [x] W1.B: app replace strategy + tests (153 tests, +14)
- [x] Wave 2: cenários manuais validados em uso real
- [ ] Wave 3: docs + commit (deferred — commit batch final)

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Sessão >30 msgs: user perde acesso a antigas no app | Mostrar indicador "..." no topo do chat quando truncated=true (UI opcional Wave 2.5) |
| Tráfego maior em sessões ativas (full re-sync vs delta) | 30 mensagens × ~500 bytes média = 15 KB por sync. Aceitável |
| Real-time push + sync mirror race: msg real-time pode "sumir" se sync substitui sem ela | Improvável (Pi vê ela primeiro), mas: app pode sobrescrever real-time só se sessionStartedAt mudou; OR pode merge real-time msgs com novas (não-trivial). MVP: aceitar trade-off |
| User confunde "cache offline" com "estado real" | Banner offline já existe (plano 12/13). Tarja "última sync: X min atrás" quando offline (futuro) |
| Cache antigo persistente após muitos reset de Pi | Mirror substitui sempre → não acumula. Resolvido by design |

---

## Próximos planos

- **Plano 17 (renomeio do antigo 15)** — pareamento "1 por Mac, várias sessões" (mudança grande de modelo)
- **Plano 07** — relay deploy (lembrete env throttle/jitter)
