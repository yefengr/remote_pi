> **历史归档。** 原始路径：`plan/31-local-ssot.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 31 — Banco local como fonte da verdade (SSOT reativo)

**Objetivo**: inverter o fluxo de dados do app. Um **serviço escritor** consome
os eventos do canal (relay/`PeerChannel`/`ConnectionManager`) e grava no banco
local (Hive) num esquema **row-granular**; as telas consomem **streams do
banco** via repositórios **read-only**. A UI passa a mostrar **só o que está no
banco** — o banco é a fonte da verdade pro app.

Resultado esperado: Home mostra "trabalhando/ocioso" por sessão derivado do
banco (sobrevive a restart); entrar numa página lê do banco sem replay de rede;
a classe de bugs de reconciliação memória↔cache (planos 13/16) deixa de existir
porque há **uma** fonte.

## Por que (diagnóstico honesto)

Hoje o `SessionRepository` mantém `SessionState` **em memória** e usa o Hive
como **snapshot blob** (`box.put(_kDataKey, { estado inteiro })`). Reescrever o
histórico inteiro num único key a cada delta/mensagem é O(histórico) por
gravação — **essa é a lentidão percebida, não o engine do Hive**. Trocar de
engine mantendo o blob não resolveria. A correção é **granularidade por linha +
streams reativas finas**, que é o que este plano entrega. Engine continua Hive
(os boxes já são particionados por `(epk, roomId)`, então `box.watch()` por box
já dá granularidade por sessão). Migração de engine (Drift/Realm) fica como
decisão futura separada, se medições justificarem.

## Não-objetivos

- ❌ Trocar de engine (Hive → Drift/Realm). Decisão futura, medir o blob primeiro.
- ❌ Migrar dados v1. **v2 = namespace de box novo**; v1 vira arquivo morto.
- ❌ Tocar protocolo/relay/pi-extension. É **app-only** (como o plano 29).
- ❌ Persistir estado de conexão entre restarts (volátil é zerado no boot).
- ❌ Rotear deltas de streaming pelo banco (streaming é exceção em memória).
- ❌ Status rico na Home (badge/unread). Só trabalhando/ocioso.

---

## Decisões fixadas (entrevista de 2026-05-30)

| # | Decisão | Valor |
|---|---|---|
| 1 | Engine | **Fica no Hive**; refatora pra row-granular + repo reativo + streams finas. Swap de engine adiado |
| 2 | Escopo do SSOT | **Puro**: tudo que a UI mostra lê do banco (conexão/presença inclusas) |
| 3 | Volátil | Box **zerado no boot**, re-semeado pelo runtime. Durável persiste. Zero stale-online |
| 4 | Forma | **Split limpo**: `SyncService` escritor (canal→banco) + repositórios **read-only** (banco→stream). ViewModels só dependem dos leitores |
| 5 | Status na Home | **Mínimo**: trabalhando/ocioso (+ online/offline do volátil) |
| 6 | Migração | **v2 = novo namespace de box**, abandona v1, sem migração, re-sync do Pi no 1º boot |
| 7 | Streaming | **Exceção em memória**: stream puro composto no ViewModel; persiste a mensagem **finalizada** no `agent_done` |

### Defaults assumidos (vetar se discordar)

- **Índice de sessões**: box durável top-level `sessions_index` (key `<epk>:<roomId>`)
  pra Home fazer query cross-session barata (os boxes por-sessão não dão isso).
- **Optimistic + dedupe**: envio do usuário → insere `MessageRecord` pendente
  com o `id` estável do protocolo; o echo dedupa por `id` (PK). Sem id novo.
- **Projeção incremental**: os read-repos mantêm a lista em memória e atualizam
  **incremental** no `BoxEvent` (não re-leem o box inteiro por evento — senão
  volta a ser O(n)).
- **Sequenciamento**: este plano **reescreve o data layer que o plano 30 acabou
  de tocar** (`session_repository`, `session_history_store`, `session_state`).
  Deve entrar **depois** da consolidação/commit dos planos 29+30.

---

## Modelo de dados (Hive v2)

Namespace novo (ex.: `Hive.initFlutter('rp_v2')` ou subdir `v2/`). Três famílias
de box:

```
DURÁVEL  msgs:<epk>:<roomId>     key = seq (int monotônico)  → MessageRecord
DURÁVEL  sessions_index          key = <epk>:<roomId>        → SessionIndexRecord
VOLÁTIL  runtime  (zerado@boot)  key = <epk>:<roomId>        → RuntimeRecord
```

```dart
// data/models/ (toJson/fromJson — Hive guarda Map)
class MessageRecord {
  final String id;          // PK; dedupe optimistic↔echo
  final int seq;            // ordem dentro da sessão
  final MsgRole role;       // user | assistant | tool
  final String text;
  final MessageImage? image;     // plano 30
  final ToolEventData? tool;     // request+result colapsado
  final DateTime ts;
  final bool pending;            // optimistic, ainda sem echo
}

class SessionIndexRecord {
  final String epk, roomId;
  final String displayName;
  final SessionActivity status;  // idle | working   (#5)
  final DateTime? lastMessageAt;
  final String? lastMessagePreview;
  final DateTime? sessionStartedAt;
}

class RuntimeRecord {            // VOLÁTIL — nunca confiar entre restarts (#3)
  final ConnectionStatus connection;  // connecting/online/offline/retrying
  final PresenceState presence;        // alive/stale/unknown
}
```

`SessionActivity` deriva do ciclo: turn start → `working`; `agent_done`/erro →
`idle`. Streaming **não** mora no banco (#7).

---

## Estrutura esperada

```
app/lib/
├── data/
│   ├── sync/
│   │   └── sync_service.dart        ← escritor: canal → banco (passo 2)
│   ├── local/
│   │   ├── boxes.dart               ← nomes/abertura v2 + wipe do volátil@boot (passo 1)
│   │   └── records/                 ← MessageRecord/SessionIndexRecord/RuntimeRecord (passo 1)
│   └── repositories/
│       ├── session_read_repository.dart  ← watchMessages/watchRuntime (passo 3)
│       └── home_read_repository.dart      ← watchSessions (passo 3)
└── ui/
    ├── chat/viewmodels/chat_viewmodel.dart  ← compõe DB + streaming em memória (passo 4)
    └── home/viewmodels/home_viewmodel.dart  ← watchSessions (passo 4)
```

`SessionRepository` atual é desmontado: o wiring de canal migra pro `SyncService`;
o estado em memória + blob saem.

---

## Passo 1 — camada local (boxes v2 + records + wipe volátil)

`data/local/boxes.dart`: abre o namespace v2; helpers `msgsBox(epk,roomId)`,
`sessionsIndexBox()`, `runtimeBox()`; **zera o `runtime` no bootstrap** (antes de
qualquer read-repo assinar / antes do `runApp`). `data/local/records/*`: os 3
records com `toJson/fromJson`.

**Aceite**: testes de roundtrip dos records; teste que o `runtime` abre **vazio**
após "restart" (re-init); `flutter analyze` 0 issues.

---

## Passo 2 — `SyncService` (escritor)

Único mutador do banco. Assina `ConnectionManager` + `PeerChannel`:
- `user_message` (echo) / `agent_message` / `agent_done` / tool events →
  upsert `MessageRecord` no `msgs:` box (dedupe por `id`) + atualiza
  `SessionIndexRecord` (`lastMessage*`, `status`).
- turn start → `status=working`; `agent_done`/erro → `status=idle`.
- conexão/presença → escreve `RuntimeRecord` no box volátil.
- envio do usuário → `MessageRecord` **pending**; echo limpa o pending (mesmo id).
- `session_sync`/recovery → preenche `msgs:` + index (re-sync do Pi no 1º boot, #6).
- **streaming**: expõe **um `Stream<StreamingMessage>` em memória** (não escreve
  no banco); só grava a mensagem finalizada no `agent_done` (#7).

**Aceite** (fakes do canal): `user_message`→1 `MessageRecord` + index atualizado;
optimistic send + echo = 1 registro (sem duplicar); turn→`working`, done→`idle`;
delta de streaming **não** gera write no banco; reconnect re-sincroniza sem
duplicar.

---

## Passo 3 — repositórios read-only

`SessionReadRepository`: `watchMessages(epk,roomId) → Stream<List<MessageRecord>>`
(projeção incremental sobre `box.watch()`), `watchRuntime(...) → Stream<RuntimeRecord>`.
`HomeReadRepository`: `watchSessions() → Stream<List<SessionIndexRecord>>` (sobre
`sessions_index.watch()`). **Sem** dependência do canal — só leem banco.

**Aceite**: escrever no box (via fake/SyncService) → stream emite a lista nova;
projeção é incremental (não re-lê o box inteiro por evento — teste com spy/contagem).

---

## Passo 4 — ViewModels + UI

- `ChatViewModel`: compõe `watchMessages` (banco) + `streamingStream` (memória,
  #7) + `watchRuntime` (banco) → `ChatState`. UI usa `Selector` pra rebuild
  estreito.
- `HomeViewModel`: `watchSessions()` → tiles com "trabalhando/ocioso" (#5) +
  online/offline (do `RuntimeRecord`).
- Registrar `SyncService` + read-repos em `config/dependencies.dart`; bindar VMs
  no router. Remover o `SessionRepository`/`sessionStream` antigos.

**Aceite**: widget tests — escrever mensagens no banco reflete na lista do chat;
Home mostra "trabalhando" quando o index marca `working`; contagem de rebuild
não cresce ao reentrar na página (fonte = banco). `flutter analyze` 0 issues;
`flutter test` verde; builds iOS+Android.

---

## Riscos

1. **`box.watch()` é grosso** (emite por qualquer key do box). Mitigação:
   boxes já particionados por sessão + **projeção incremental** no read-repo
   (atualiza só o registro do evento). Se a granularidade ainda incomodar, é o
   gatilho pra reavaliar Drift (query reativa fina nativa) — decisão futura.
2. **Ordem de boot**: o `runtime` precisa ser zerado **antes** de qualquer
   read-repo assinar. Fazer no `setupDependencies`/bootstrap, síncrono.
3. **Exceção do streaming** (#7) é a **única** exceção ao SSOT — vigiar pra não
   virar porta pra outras (senão o SSOT erode).
4. **Cross-PC/mesh** (planos 24/25): o `sessions_index` precisa refletir sessões
   de PCs irmãos quando aparecerem. Ponto de integração com a lista de peers da Home.
5. **Reescreve arquivos que o plano 30 tocou** — entrar só após consolidar 29+30.

---

## Definition of Done

- [x] Passo 1: boxes v2 + 3 records + wipe volátil no boot; testes roundtrip
- [x] Passo 2: `SyncService` único mutador; dedupe optimistic↔echo; status working/idle; streaming fora do banco; re-sync no boot; testes
- [x] Passo 3: `SessionReadRepository` + `HomeReadRepository` read-only com projeção incremental; testes
- [x] Passo 4: `ChatViewModel` (banco + streaming em memória) + `HomeViewModel` (working/idle); `SessionRepository` antigo removido; router/DI atualizados
- [x] `flutter analyze` 0 issues; `flutter test` verde; builds iOS+Android
- [x] Verificação: UI só lê dos read-repos (nenhum widget assina o canal direto); volátil não sobrevive a restart; nenhum write de delta de streaming no banco
- [x] Commit: `feat(plan-31): local DB as single source of truth (reactive SSOT)` — `51181b0`

---

## Próximos planos

- ~~**Swap de engine (condicional)**: avaliar Drift se `box.watch()` virar gargalo.~~
  **Descartado (2026-05-30)** — decisão do dono: **não trocar de engine**, fica no Hive.
- ~~**Status rico na Home**: unread/badge/erro.~~ **Descartado (2026-05-30)** —
  decisão do dono: **não fazer status rico**.
