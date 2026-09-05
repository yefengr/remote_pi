> **历史归档。** 原始路径：`plan/36-push-notifications.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# 36 — Push Notifications (FCM via central operado pelo publisher)

## Contexto

Push foi **cortado do MVP** (`../../adr/20260518-closed-decisions.md:76`) e adiado pra "v2 após MVP
validado" (`../../adr/20260518-closed-decisions.md:131`). O MVP está validado (PC-mesh em produção,
submissão App Store em curso). Este plano **fecha** esse item.

A linha `../../adr/20260518-closed-decisions.md:81` antecipava "push decora `tool_request`". Isso está
**superado**: o sistema de approval foi removido (`../../adr/20260518-closed-decisions.md:80`), não há
mais `tool_request` como gatilho. O gatilho deste plano é **`end_turn` + agente
bloqueado esperando o usuário** (pergunta/permissão).

### A verdade dura que molda tudo (não-negociável)

FCM/APNs têm um invariante: **uma mensagem só é entregue a um token que pertence
ao mesmo Firebase project das credenciais de quem envia.** O app publicado
(`work.jacobmoura.remotepi.app`) embute **um** Firebase project. Logo:

- Todo install oficial gera token do **seu** projeto; só uma service account
  **sua** envia pra ele.
- **O serviço central de push é obrigatoriamente operado pelo publisher (você).**
- **Self-hosting do relay NÃO se estende a push.** Um relay self-hosted só ganha
  push se (a) entrar na allowlist do central oficial, ou (b) o operador forkar o
  app + Firebase próprio + central próprio. Sem isso, **não há notificação** — o
  usuário vê o que aconteceu **ao abrir o app** (sync normal de mensagens).

Isso é declarado abertamente (mesma honestidade do "nunca afirmar E2E").

### Por que o relay não pode ser a raiz de confiança

Scout (2026-06-04) confirmou: admissão no relay = posse da chave Ed25519, **sem
allowlist** (`relay/src/handlers/peer.rs:50-78`); relay é **open-source +
self-hosted** → qualquer segredo embutido vaza. Portanto a confiança ancora em
**quem o publisher explicitamente permite** (allowlist por API key), não no relay.

## Arquitetura — decisões fechadas (entrevista 2026-06-04)

| # | Decisão |
|---|---|
| 1 | **Central de push operado pelo publisher.** Relay recebe a URL do central via env. |
| 2 | **Central stateless.** Estado (tokens) vive no relay (SQLite). Central só repassa pro FCM. |
| 3 | **Payload = ponteiro opaco.** Banner: título `Message for <nome-da-sessão>`, subtítulo "toque para ver". `data` carrega **só `room_id`** (sem `peer_epk` — não dá ao Google identificador estável do desktop). App resolve a sessão **localmente** casando `room_id` contra o Hive. Nome da sessão viaja no payload; **conteúdo nunca**. |
| 4 | **Token direto** (não topic). Tabela `device_tokens` no relay, keyed por `(pair_id, device_id)`. Upsert na rotação; GC via erro `UNREGISTERED` do FCM. iPhone+iPad = linhas distintas (tokens únicos por install; chave compartilhada não colide). |
| 5 | **Sempre envia; app se silencia em foreground.** FCM em foreground não vira banner automático — app trata via `onMessage`, só atualiza badge. Relay não chama central se o par tem 0 tokens. |
| 6 | **Gatilho = `agent_end` com `willRetry:false`** ("agente te devolveu a vez"). Pi **não distingue** "terminou" de "travado esperando você" — colapsam no mesmo evento (sem `ask`/elicitation/permission no SDK, v0.78). `willRetry:true` = retry transitório → **não** notifica. (Revisa a 7=B da entrevista: "blocked" não é observável no SDK.) |
| 7 | **Extension emite o evento.** Fluxo: `extension → relay → central`. Extension fina (só "evento notificável na sessão X"); relay concentra tokens + decisão + chamada ao central. |
| 8 | **Segurança do central = allowlist.** API key (env privada, **nunca** default do open-source) + IP/CIDR + rate-limit por entrada. Oficial com limite maior. Acesso via **issue no projeto**. |
| 9 | **Rate-limit em 3 camadas aninhadas:** por **token** (anti-spam a um device, no central) ⊂ por **owner key** (isolamento de vizinho barulhento, **enforçado no relay** + blocklist cirúrgica) ⊂ por **caller/api_key** (capacidade do central). |
| 10 | **Sem polling em background. Sem log de notificações no relay. Sem aba dedicada no app.** Só push como aviso; conteúdo ao abrir o app; **badges de não-lido** nos tiles, derivados app-side. |

### Modelo de ameaças (adendo ao `../../adr/20260518-closed-decisions.md:97`)

- **Central vê**: token FCM, **nome da sessão**, timing. **Nunca o conteúdo.**
- **Push é não-confiável por design** — é só aviso. Se o FCM dropar, o conteúdo
  continua íntegro (visto ao abrir o app). Push não carrega responsabilidade de
  entrega.
- **Relay self-hosted sem config de push** → não dispara push (no-op gracioso).

## Componentes & mudanças

### A. Central de push — **NOVO componente** (`push/`)
Serviço stateless, exposto na internet (ou atrás de proxy/VPC). **Stack: Rust**
(consistência com o relay, footprint pequeno, sem runtime Node). Não precisa do
SDK firebase-admin: o OAuth2 da service account (scope
`https://www.googleapis.com/auth/firebase.messaging`, com cache/refresh) é
resolvido por crate madura — `oauth_fcm` ou `fcm_v1` (ambas sobre `yup-oauth2`) —
e o envio é `reqwest` POST pra `…/v1/projects/{id}/messages:send`. Sem multicast:
o relay manda **1 token por request**.

- **Endpoint** `POST /push`: body `{ fcm_token, owner_bucket, payload_opaco }`,
  header `Authorization: Bearer <api_key>`.
- **Auth**: valida `api_key` contra `PUSH_ALLOWLIST` (env). Cada entrada =
  `{ label, api_key, ip_or_cidr, rate_limit }`. IP de origem deve casar o
  `ip_or_cidr`. Fora da allowlist → 403.
- **Rate-limit**: por `api_key` (teto do caller) + por `fcm_token` (anti-spam);
  contadores **efêmeros** (memória/Redis), não durável.
- **Envio**: monta FCM HTTP v1 `notification`(title/body genéricos) + `data`
  (`{ room_id }`); manda via service account. Repassa erro `UNREGISTERED`/
  `NOT_FOUND` na resposta pro relay fazer GC.
- **Config (env)**: `PUSH_ALLOWLIST`, `GOOGLE_APPLICATION_CREDENTIALS`
  (service account), `FCM_PROJECT_ID`.

### B. Relay (`relay/`) — Rust
- **Nova migration `002_device_tokens.sql`** (precedente: `relay/migrations/`):
  ```sql
  CREATE TABLE IF NOT EXISTS device_tokens (
    pair_id    TEXT NOT NULL,   -- owner/app pubkey (base64)
    device_id  TEXT NOT NULL,   -- UUID estável gerado pelo app
    fcm_token  TEXT NOT NULL,
    platform   TEXT NOT NULL,   -- ios | android
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pair_id, device_id)
  );
  ```
- **Control frames novos** no `match` de `peer.rs:180-333` (padrão
  `room_meta_update`):
  - `register_push_token` (app → relay): `{ device_id, fcm_token, platform }` →
    UPSERT em `device_tokens` keyed por `(peer_id, device_id)`.
  - `notify_event` (extension → relay): `{ room_id, kind: "end_turn"|"blocked" }`
    → dispara o caminho de push.
- **Caminho de push** (novo módulo `src/push/`): em `notify_event`, lookup dos
  tokens do par; aplica **rate-limit por owner key** (+ blocklist); pra cada token,
  `tokio::spawn` um `POST` ao central (não bloqueia o loop de routing). No retorno
  `UNREGISTERED`, deleta a linha (GC).
- **`reqwest` vai pra `[dependencies]`** (hoje dev-only, `Cargo.toml:23`).
- **Config nova (env, `main.rs:12-25`)**: `REMOTEPI_PUSH_URL`,
  `REMOTEPI_PUSH_API_KEY`, `REMOTEPI_PUSH_OWNER_RATE`,
  `REMOTEPI_PUSH_OWNER_BLOCK`. **Faltou URL+key → push é no-op** (relay não
  dispara; nenhum estado de notificação).

### C. Extension (`pi-extension/`) — Node/TS
- **Emitir `notify_event`** via `sendControl()` (`relay_client.ts:170-173`) no
  handler **`agent_end`** (`index.ts:1091`), **gated por `willRetry===false`**.
  - **Não** usar `turn_end` (`index.ts:1121`): pulsa a cada LLM call no meio de
    tarefa multi-step → buzinaria durante o trabalho. `agent_end` é o "acabou
    tudo, é sua vez".
  - **`blocked` não é observável** no SDK do Pi (v0.78): não há `ask`/
    elicitation/permission; pergunta e conclusão são o mesmo `agent_end`. O
    gatilho único já cobre os dois casos.
- **Edge cases gated** (suprimir o push, mantendo `agent_done` normal):
  `willRetry:true` (retry) sempre suprime; `cancelled`/`error` terminal conforme
  decisão da entrevista (passo 4).
- Frame: `{ type: "notify_event", room_id: _myRoomId }`.

### D. App (`app/`) — Flutter
- **Firebase**: adicionar `firebase_core` + `firebase_messaging`,
  `GoogleService-Info.plist` / `google-services.json`. (Hoje: zero Firebase.)
- **`device_id` estável**: gerar UUID no 1º launch, persistir no Hive (sobrevive
  rotação de token; reinstall = novo device). (Hoje não há device id estável.)
- **Registro**: no connect/pairing, `getToken()` → enviar `register_push_token`
  pro relay pelo canal WS já autenticado. `onTokenRefresh` → reenviar.
- **Foreground silence**: `FirebaseMessaging.onMessage` não exibe banner; só
  atualiza estado. Tap em push (background) → app **resolve a sessão localmente**
  casando `room_id` contra as sessões do Hive (`epk:roomId`). Ambiguidade rara
  (celular pareado a 2 Pis com o mesmo `room_id`) → cai na lista / desambígua pelo
  nome da sessão.
- **Badges de não-lido**: marcador `last_read` por sessão no Hive; badge = msgs
  novas além do marcador, derivado do sync existente (`SessionIndexRecord` já tem
  `lastMessageAt`/`lastMessagePreview`, `session_index_record.dart`). **Sem aba
  dedicada, sem tabela no relay.**
- **Permissão de notificação**: pedir no momento certo (pós-onboarding/pareamento).

### E. Doc de relay customizado (`site/` docs + README do relay)
- Env vars (`REMOTEPI_PUSH_URL`, `REMOTEPI_PUSH_API_KEY`, owner-rate/block) e o
  **no-op quando ausentes**.
- **Como obter push oficial**: abrir **issue no repositório** solicitando uma
  chave; o mantenedor revisa e cria a entrada na allowlist (`label`, `api_key`,
  `ip/cidr`, `rate_limit`) e devolve a `api_key`.
- Alternativa: subir central próprio (allowlist própria + Firebase próprio + fork
  do app).
- Sem push → **não há notificação**; usuário vê ao abrir o app.

## Passos (com critério de aceite)

1. **Central skeleton (Rust)** — `push/` em Rust: `POST /push` com auth por
   allowlist + rate-limit (token + caller); OAuth2 via `oauth_fcm`/`fcm_v1`
   (`yup-oauth2`); envio FCM v1 via `reqwest`.
   *Aceite*: POST autorizado com token de teste entrega push real num device;
   POST sem/`api_key` errado → 403; flood estoura rate-limit.
2. **Relay — schema + registro de token** — migration `002`, control frame
   `register_push_token` com UPSERT.
   *Aceite*: app registra token; reenvio com mesmo `device_id` faz UPDATE (não
   duplica); `cargo test` verde.
3. **Relay — caminho de push** — `notify_event` → lookup tokens → rate-limit por
   owner (+ blocklist) → POST central async → GC em `UNREGISTERED`. Env vars +
   no-op se ausentes.
   *Aceite*: `notify_event` com config dispara push; sem `REMOTEPI_PUSH_URL` é
   no-op silencioso; token morto é removido após erro do FCM; owner acima do
   limite é throttled **sem afetar outros owners**.
4. **Extension — gatilho** — emitir `notify_event` no `agent_end` **gated por
   `willRetry===false`**; suprimir nos edge cases decididos (`cancelled`, `error`
   terminal).
   *Aceite*: agente concluir um loop (`willRetry:false`) dispara push num device
   pareado; um retry transitório (`willRetry:true`) **não** dispara; cancel/erro
   seguem a decisão da entrevista.
5. **App — Firebase + registro + foreground silence** — integrar FCM, gerar
   `device_id`, registrar token no connect, silenciar em foreground, abrir sessão
   no tap.
   *Aceite*: app fechado recebe banner "Message for <sessão>"; app em foreground
   não mostra banner; tap abre a sessão certa.
6. **App — badges de não-lido** — `last_read` por sessão + badge no tile.
   *Aceite*: sessão com msg nova além do `last_read` mostra badge; abrir a sessão
   zera; persiste entre reinícios (Hive).
7. **Docs** — seção de relay customizado (E) no site + README do relay.
   *Aceite*: `pnpm lint && pnpm build` no site; doc cobre env vars, no-op, e o
   fluxo de issue→allowlist.
8. **Registrar decisões** — atualizar `../../adr/20260518-closed-decisions.md`: riscar "Sem push no MVP"
   com nota → "implementado no plano 36"; mover "Push notifications v2" de
   "Em aberto" pra fechado, apontando este plano.

## DoD

- [ ] 1 — Central: `POST /push` com allowlist + rate-limit + envio FCM real
- [ ] 2 — Relay: migration `002` + `register_push_token` (UPSERT por `device_id`)
- [ ] 3 — Relay: `notify_event` → push async + GC + rate-limit por owner + no-op sem config
- [ ] 4 — Extension: `notify_event` em `agent_end(willRetry:false)`; edge cases (retry/cancel/erro) gated
- [ ] 5 — App: FCM + `device_id` + registro + foreground silence + tap→sessão
- [ ] 6 — App: badges de não-lido por tile (derivados app-side)
- [ ] 7 — Docs de relay customizado (site + README relay)
- [ ] 8 — `../../adr/20260518-closed-decisions.md` atualizado (push fechado, apontando plano 36)

## Riscos & próximos

- **`blocked` não é observável no SDK do Pi (v0.78)** — resolvido colapsando no
  gatilho único `agent_end(willRetry:false)`, que já cobre "terminou" e "esperando
  você" (são o mesmo evento). Se um dia o Pi expor elicitation/permission, um
  banner diferenciado ("precisa de você") vira upgrade aditivo.
- **Custo Apple Developer** ($99/ano) já assumido pela submissão App Store —
  não é bloqueio novo.
- **Upgrade futuro pra push em relay self-hosted (sem allowlist manual)**:
  exigiria attestation ancorada no device (App Attest / Play Integrity) emitindo
  *push grants* assinados pelo central, carregados pelo relay. Desenho discutido e
  **deliberadamente adiado** — a tabela `device_tokens` pode ganhar coluna `grant`
  (nullable) sem rewrite. Só vale se push self-hosted virar demanda real.
- **Múltiplos devices recebem o mesmo push** (iPhone+iPad): aceitável; o silêncio
  em foreground reduz o ruído naturalmente.
