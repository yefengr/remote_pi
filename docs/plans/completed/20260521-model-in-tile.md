> **历史归档。** 原始路径：`plan/18-model-in-tile.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 18 — Modelo IA no tile da Home

## Contexto

Hoje o `SessionTile` na Home mostra:
- Title: nome do projeto / apelido
- Subtitle: "Last paired: 58m ago"

Subtitle é info de baixo valor depois do primeiro pareamento. Substituir
pelo **modelo de IA atualmente ativo** naquela sessão é muito mais útil
("claude-sonnet-4.5", "gpt-4o", etc) — user identifica visualmente onde
está rodando o quê.

## Decisões fixadas

| Decisão | Valor / razão |
|---|---|
| **D1: formato** | String simples (model name). Provider implícito no nome (ex: "claude-sonnet-4.5", "gpt-4o"). Mais limpo na UI |
| **D2: fallback** | Sem `model` conhecido (Pi não enviou ainda OU room offline) → mostra "Last paired: X ago" (atual) |
| **D3: propagação** | Pi envia model inicial no `hello.room_meta`. Quando user troca via `pi.on("model_select")`, Pi envia novo control frame `room_meta_update`. Relay broadcast como `room_meta_updated` |
| **D4: cache** | Último model conhecido fica em memória no app (`RoomInfo.model`). Persistir no hive cache pra reconectar mostrar enquanto update novo não chega |
| **D5: truncate UI** | Se model >20 chars (ex: "claude-3-5-sonnet-20241022"), truncar mantendo o nome principal (ex: "claude-sonnet-4.5") |

## Novos types no protocolo

### hello.room_meta ganha `model`

```jsonc
// Antes
{ "type": "hello", "pubkey": "...", "room_id": "...", "room_meta": { "name": "...", "cwd": "..." } }

// Depois
{ "type": "hello", "pubkey": "...", "room_id": "...", "room_meta": { "name": "...", "cwd": "...", "model": "claude-sonnet-4.5" } }
```

### Novo control frame `room_meta_update` (Pi → Relay)

```jsonc
{ "type": "room_meta_update", "room_id": "...", "meta": { "model": "gpt-4o" } }
```

Pi envia ao detectar mudança via `pi.on("model_select")`. Relay atualiza
RoomMeta internamente e broadcast pros subscribers.

### Novo broadcast `room_meta_updated` (Relay → App)

```jsonc
{ "type": "room_meta_updated", "peer": "<epk>", "room_id": "...", "meta": { "model": "gpt-4o" } }
```

Estrutura espelha `room_announced` mas só pra updates. App atualiza
RoomInfo.

### `room_announced` e `rooms` ganham `model` em `meta`

```jsonc
// room_announced
{ "type": "room_announced", "peer": "...", "room_id": "...", "name": "...", "cwd": "...", "started_at": ..., "model": "claude-sonnet-4.5" }

// rooms (snapshot)
{ "type": "rooms", "peer": "...", "rooms": [{ "room_id": "...", "name": "...", "cwd": "...", "started_at": ..., "model": "..." }, ...] }
```

## Estrutura esperada

### Pi-extension

- `src/index.ts`:
  - Helper `_currentModelName(): string | undefined` lê `_pi.state.model.name` (ou equivalente do SDK)
  - `_cmdStart`: passa `model` no `room_meta` do hello
  - Novo hook: `pi.on("model_select", (event) => { ... })` envia control frame `room_meta_update`
  - Helper `_sendRoomMetaUpdate({ model })` via relay (control frame)
- `src/transport/relay_client.ts`:
  - Hello aceita `model` em room_meta
  - Novo método `sendControl(frame)` (se ainda não tem) pra enviar `room_meta_update`
- Tests: hello carrega model, model_select dispara update, etc

### Relay

- `src/rooms.rs` / `peers/registry.rs`:
  - `RoomMeta` ganha `model: Option<String>`
  - Handler `room_meta_update`: atualiza meta interna + broadcast pros subscribers
- `src/handlers/peer.rs`:
  - Parse `room_meta_update` no input loop (junto com subscribe_rooms, etc)
  - Broadcast `room_meta_updated` (formato análogo a room_announced)
- Hello: aceita `model` opcional em `room_meta`
- `room_announced` e `rooms` payload incluem `model` quando presente
- Tests

### App

- `lib/protocol/protocol.dart`:
  - `RoomInfo` ganha `model: String?`
  - `RoomAnnounced` parse `model`
  - `RoomsSnapshot` parse `model` em cada room
  - Novo type `RoomMetaUpdated` ({peer, roomId, meta: {model?}})
  - ServerMessage.fromJson handle 'room_meta_updated'
- `lib/data/transport/connection_manager.dart`:
  - Handler `RoomMetaUpdated` → atualiza `_roomsByPeer[peer]` (substitui RoomInfo daquela room com novo model, mantendo outros campos)
- `lib/ui/home/widgets/session_tile.dart`:
  - Se `room.model != null`: subtitle = `model` (truncado a 24 chars se necessário)
  - Senão: fallback "Last paired: <relative>" (comportamento atual)
- Cache hive (plano 11): `RoomInfo` serializa `model` no cache → sobrevive reconnect
- Tests

### Contracts

- `protocol.md`: hello.room_meta ganha model, room_announced/rooms ganham model, novo `room_meta_update` (app perspective) + `room_meta_updated` (server perspective)
- Fixtures: 1 nova (`room_meta_updated.jsonl`)

## Passos com critério de aceite

### Wave 0 — Contratos
- [ ] Atualizar `protocol.md`: hello.room_meta + room_announced + rooms + 2 control frames novos
- [ ] Adicionar 1 fixture `room_meta_updated.jsonl`
- [ ] Atualizar `pairing.md` documentando model no room_meta

### Wave 1 — Subprojetos em paralelo

#### W1.A — Pi-extension
- [ ] `_currentModelName()` helper (lê SDK)
- [ ] `_cmdStart` envia `model` em room_meta do hello
- [ ] `pi.on("model_select", ...)` → envia `room_meta_update`
- [ ] Tests: hello carrega model, model_select dispara update
- [ ] `pnpm test` verde

#### W1.B — Relay
- [ ] `RoomMeta` ganha `model: Option<String>`
- [ ] Handler `room_meta_update`: update interno + broadcast `room_meta_updated`
- [ ] `room_announced` / `rooms` include `model`
- [ ] Tests: meta update broadcast, snapshot inclui model
- [ ] `cargo test` verde

#### W1.C — App
- [ ] `RoomInfo.model` field
- [ ] `RoomMetaUpdated` type novo
- [ ] ConnectionManager handler `RoomMetaUpdated` → atualiza state
- [ ] `SessionTile` subtitle = model (fallback last paired)
- [ ] Cache hive persiste model
- [ ] Tests
- [ ] `flutter test` verde

### Wave 2 — Roundtrip manual

- [ ] Pi com claude-sonnet → app vê "claude-sonnet" no subtitle do tile
- [ ] No Pi, troca pra GPT (`/model` ou similar do Pi SDK) → app subtitle atualiza pra "gpt-4o" em <1s (push real-time)
- [ ] Reconectar app: cache mostra model anterior enquanto novo update não chega
- [ ] Pi sem mudança de model: subtitle estável

### Wave 3 — Polish
- [ ] Atualizar `../../adr/20260518-closed-decisions.md`: model in tile como recurso de UX
- [ ] Commit

## Definition of Done

- [x] Wave 0: contratos + 1 fixture
- [x] W1.A: pi-ext tests verde (125, +6)
- [x] W1.B: relay tests verde (33, +3)
- [x] W1.C: app tests verde (215, +7)
- [ ] Wave 2: 4 cenários manuais OK
- [ ] Wave 3: docs + commit

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| SDK Pi não expõe `state.model.name` (ou nome técnico vs friendly) | Investigar API antes de despachar; fallback pra `model.id` se name não existir |
| Model trocado muitas vezes em sequência (UX falsa de "trocou X vezes") | Pi envia direto cada model_select. Relay/App não debounce — model_select é raro (user explicit). Se virar problema, debounce 500ms no relay |
| Cache fica stale se app offline e modelo trocou | Cache mostra último visto; update pós-reconnect substitui. Trade-off aceito |
| String "model" cresce muito | UI truncate a 24 chars. Pi envia nome canônico |
| Pi-ext legacy sem model no hello | Relay aceita ausência; app fallback pra "last paired" |

## Próximos planos

- **Plano 19+** — outras infos contextuais no tile (token count, custo, status do agent)
- **Plano 07** — relay deploy
