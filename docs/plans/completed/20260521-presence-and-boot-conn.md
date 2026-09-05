> **历史归档。** 原始路径：`plan/12-presence-and-boot-conn.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 12 — Presence push + conexão desde o boot

## Contexto

Pós uso real (2026-05-20), 2 problemas identificados:

1. **App só conecta ao entrar no chat**. Antes disso, status de peers é
   "presumido online" baseado em pareamento. User entra no app, vê tudo
   "verde", mas Pi pode estar offline há horas. Decisão original (só
   conectar no chat) revisada — vamos voltar a conectar desde o boot.
2. **Sem presença real**. Relay sabe quais peers estão WS-conectados
   (`PeerRegistry`), mas não conta a ninguém. App tenta inferir via
   ping-timeout (lento, ~50s, frágil).

Decisão: implementar **Telegram-style presence** — relay vira fonte de
verdade de online/offline, app subscreve nos peers pareados, recebe push
quando alguém conecta/desconecta.

**Conscientemente NÃO escolhemos**: centralizar relay com contas de
usuário (proposta alternativa). Mantém self-host (decisão
`../../adr/20260518-closed-decisions.md`), zero-knowledge do relay sobre identidade pessoal, e
custo de implementação 1/20 da centralização.

---

## Decisões fixadas

| Decisão | Valor / razão |
|---|---|
| **Boot conecta WS** | App ao subir → `ConnectionManager.boot()` → WS aberto. Mantém aberto enquanto app rodando. Reverte "só conectar no chat" do design original |
| **Subscribe limitado** | App só subscreve em peers que **já pareou** (`PairingStorage.listPeers()`). Zero-knowledge: relay aceita o subscribe mas não valida "pertence ao user X" |
| **Presence map em memória** | Relay mantém `Map<peer_id, Set<subscriber_peer_id>>` in-memory, limpo no disconnect. Sem persistência |
| **Broadcast on connect/disconnect** | Quando peer X (re)autentica ou desconecta, relay itera `subscribers(X)` e envia `peer_online`/`peer_offline` |
| **Presence_check sob demanda** | App pode pedir snapshot pontual: `presence_check{peers}` → `presence{states}`. Útil pra inicial após connect |
| **Limpeza** | Quando subscriber desconecta, relay remove ele de todas as Sets onde aparecia. Evita leak |

---

## Novos types no protocolo

### App → Relay (handled pelo relay, não pelo peer)

```jsonc
{ "type": "subscribe_presence", "peers": ["<epk1>", "<epk2>", ...] }
{ "type": "unsubscribe_presence", "peers": ["<epk1>", ...] }  // opcional
{ "type": "presence_check", "peers": ["<epk1>", ...] }
```

### Relay → App

```jsonc
{ "type": "peer_online",  "peer": "<epk>" }
{ "type": "peer_offline", "peer": "<epk>" }
{ "type": "presence", "states": [{"peer": "<epk>", "online": bool, "since_ts": <number|null>}, ...] }
```

> **Importante — quebra do modelo "opaco" do relay**: até hoje o relay
> nunca chamou `serde_json::from_str` no `ct`. Esses 5 novos types
> trafegam **fora** do envelope `{peer, ct}` — eles são frames próprios
> com `type` no nível superior do JSON. O relay já parseia o outer
> envelope; ele vai precisar diferenciar:
>
> - frame tem `type === "subscribe_presence" | "unsubscribe_presence" | "presence_check"` → handler interno do relay
> - frame tem `peer` e `ct` → roteamento opaco (comportamento atual)
> - frame tem `type === "hello"` ou `"auth"` → fluxo de auth Ed25519 (já existe)
>
> Isso é progressão natural; o relay já não é 100% opaco (já entende auth).

### Wire format examples

```
// app envia ao conectar
{"type":"subscribe_presence","peers":["abc1...","def2..."]}

// relay manda push quando peer abc1... conecta
{"type":"peer_online","peer":"abc1..."}

// app pede snapshot pontual
{"type":"presence_check","peers":["abc1...","def2..."]}

// relay responde com snapshot
{"type":"presence","states":[{"peer":"abc1...","online":true,"since_ts":null},{"peer":"def2...","online":false,"since_ts":1716234500000}]}
```

---

## Estrutura esperada

### Relay (Rust)

- Novo módulo `src/presence.rs`:
  - `PresenceManager { subscribers: HashMap<PeerId, HashSet<PeerId>> }`
  - `subscribe(subscriber, peers)`
  - `unsubscribe(subscriber, peers)`
  - `unsubscribe_all(subscriber)` — chamado em disconnect
  - `subscribers_of(peer) -> &HashSet<PeerId>` — pra broadcast
- `PeerRegistry`:
  - Ao autenticar peer X: broadcast `peer_online{peer: X}` pros `subscribers_of(X)`
  - Ao desconectar peer X: broadcast `peer_offline{peer: X}` + remove X de `subscribers` (se era subscriber de alguém também)
- `handle_peer`: novo branch antes do roteamento:
  ```rust
  if let Some(t) = frame.get("type").and_then(Value::as_str) {
    match t {
      "subscribe_presence"   => presence.subscribe(self_id, peers); continue;
      "unsubscribe_presence" => presence.unsubscribe(self_id, peers); continue;
      "presence_check"       => respond with snapshot; continue;
      _ => {} // cai pro roteamento normal de outer envelope
    }
  }
  ```
- Tests: subscribe + connect peer → push recebido; disconnect → push; presence_check sync

### Pi-extension

- **Zero mudança.** Bye do plano anterior já cobre offline graceful. Relay sabe via `PeerRegistry.disconnect()`.

### App (Flutter)

- `lib/data/transport/connection_manager.dart`:
  - Restaurar caller de `boot()` — chamar em `MainApp.initState` OU adicionar `await _conn.boot()` em `BootState.load` (router boot)
  - Após boot bem-sucedido: emit `subscribe_presence` com epks de todos `PairingStorage.listPeers()`
  - Handler de inbound: tratar `peer_online` / `peer_offline` / `presence` (fora do peer_channel atual — vem direto no WS, não via inner cifrado)
  - Manter mapa `_presenceByEpk: Map<String, PresenceState>` (online/offline/unknown + since_ts)
  - Expor `Stream<PresenceUpdate>` + `presenceFor(epk)` getter
- `lib/data/transport/ws_transport.dart`:
  - Hoje envelope é só `{peer, ct}`. Agora aceitar receber frames sem `peer` (presence). Logic: se frame tem `type` no topo (não é envelope) → roteia pra presence handler. Se tem `peer` + `ct` → continua canal normal.
  - Reavaliar separação entre WsTransport (raw WS) vs ConnectionManager (lifecycle) — talvez WsTransport ganha 2 streams: one for envelope-typed (chat msgs) e one for control frames (presence)
- `lib/ui/home/states/home_state.dart`:
  - `HomeList` ganha `statusByEpk: Map<String, PresenceState>` em vez de só `activeStatus`
- `lib/ui/home/viewmodels/home_viewmodel.dart`:
  - Escuta presenceStream → atualiza `statusByEpk` no state
- `lib/ui/home/widgets/session_tile.dart`:
  - Dot agora consulta `statusByEpk[peer.remoteEpk]` em vez de só "ativo ou não"
- `lib/routing/app_router.dart` OU `lib/main.dart`:
  - Disparar `ConnectionManager.boot()` ANTES do primeiro frame da Home renderizar
- `lib/protocol/protocol.dart`:
  - 5 types novos como `ServerMessage`/`ClientMessage` subtypes (decidir nomenclatura — talvez `ControlMessage` ou ficar como ClientMessage/ServerMessage normais)

---

## Passos com critério de aceite

### Wave 0 — Contratos (orquestrador-only)

- [ ] Atualizar `.orchestration/contracts/protocol.md` — adicionar 5 types, documentar que são "fora do envelope" (frames próprios)
- [ ] Adicionar 5 fixtures: `subscribe_presence.jsonl`, `unsubscribe_presence.jsonl`, `presence_check.jsonl`, `peer_online.jsonl`, `peer_offline.jsonl`, `presence.jsonl`
- [ ] Esclarecer em `protocol.md` que esses frames são parseados pelo relay (diferente dos atuais)

### Wave 1 — Subprojetos em paralelo

#### W1.A — Relay
- [ ] `PresenceManager` (módulo novo)
- [ ] Handler de subscribe/unsubscribe/check no `handle_peer` (antes do roteamento)
- [ ] Broadcast em PeerRegistry.{connect,disconnect}
- [ ] Cleanup de subscribers em disconnect
- [ ] Tests: subscribe + 2nd peer connects → push; disconnect → push; presence_check sync; unsubscribe pra
- [ ] `cargo build && cargo test` verde

#### W1.B — App
- [ ] Restaurar `ConnectionManager.boot()` chamado no app start (em vez de só no chat)
- [ ] Após connect: enviar `subscribe_presence` com peers pareados
- [ ] Refatorar WsTransport pra rotear control frames separadamente dos envelope frames
- [ ] `PresenceState` + `Stream<PresenceUpdate>` no ConnectionManager
- [ ] HomeViewModel escuta presence + atualiza `statusByEpk`
- [ ] SessionTile usa `statusByEpk` pro dot
- [ ] 5 types novos em `protocol.dart`
- [ ] Quando pareia novo Pi: enviar subscribe pra ele também
- [ ] Tests: subscribe ao boot, push atualiza estado, presence_check sync, novo pair → re-subscribe
- [ ] `flutter analyze && flutter test` verde

### Wave 2 — Roundtrip manual

- [ ] App aberto, 2 Pis pareados, ambos OFFLINE: ambos dots cinza na Home
- [ ] Pi A roda `/remote-pi start`: dot do A vira verde em <1s na Home, sem app reiniciar
- [ ] Pi A roda `/remote-pi stop`: dot vira cinza em <1s
- [ ] Pi A `/remote-pi start` E Pi B `/remote-pi start` em paralelo: ambos verdes
- [ ] User pareia novo Pi C: subscribe atualizado, vê dot do C também
- [ ] Trocar de network no celular (WiFi → 4G): WS reabre, presence se restabelece em <5s

### Wave 3 — Polish

- [ ] Atualizar `../../adr/20260518-closed-decisions.md`: decisão "boot conecta WS desde o início" + decisão "subscribe presence em peers pareados"
- [ ] Atualizar `README.md` raiz: mencionar presence push como feature
- [ ] Commit consolidado

---

## Definition of Done

- [x] Wave 0: contratos + 6 fixtures
- [x] W1.A: relay com PresenceManager + tests (18 tests, +8)
- [x] W1.B: app com boot + subscribe + dots em real-time + tests (119 tests, +9)
- [ ] Wave 2: roundtrip manual 6 cenários verdes
- [ ] Wave 3: docs + commit

---

## Próximos planos

- **`plan/07-relay-deploy.md`** — agora ganha mais peso (relay com presence vira mais útil em produção)
  - **Lembrete (memory `project-relay-throttle-env-future`)**: incluir vars de ambiente pra
    throttle/jitter/rate-limit antes de subir produção
- **`plan/13-...`** — alguma feature futura

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| WsTransport fica confuso com 2 tipos de frame | Separar em 2 streams claros: `envelopeMessages` (peer/ct) e `controlMessages` (type no topo). Documentar |
| Bateria do celular com WS sempre aberto | Mobile já tolera bem (Telegram, WhatsApp). Ping a cada 25s = ~3 KB/min. Mínimo |
| Race: pareia novo Pi → subscribe envia → resposta de online chega antes do SessionTile render | Idempotente: state map sempre tem entrada (default offline). Update reativo |
| Relay reinicia → todos os subscribes perdidos | Cliente re-subscreve no reconnect (sempre que abre WS, manda subscribe atualizado) |
| Broadcast storm (muitos peers ficam online ao mesmo tempo) | Fica pro plano 07/sucessor — vars de env pra rate-limit (memory já registrada) |
| Subscriber subscreve em peer aleatório (não pareado) — privacy leak? | Sim, qualquer um pode subscrever em qualquer epk e saber se está online. Trade-off aceito: presence é info de baixo valor; "alguém me sabe online às 22h" não é segredo crítico. Quando E2E voltar (plano 09 opc), continua igual — presence é meta-info |
