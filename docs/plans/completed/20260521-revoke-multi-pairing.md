> **历史归档。** 原始路径：`plan/08-revoke-multi-pairing.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 08 — Revoke + Multi-pairing

## Contexto

Pós-rollback E2E (plano 06) o MVP roda 1 pareamento = 1 sessão. Mas:

- `/remote-pi revoke` é stub explícito ("not implemented in MVP. Remove from
  peers.json manually") — UX hostil.
- App `SettingsViewModel` JÁ tem `revoke()` que apaga local, mas a UI mostra
  apenas `peers.first` (`SettingsReady{peer}`) — invisível pra usuário com
  múltiplos pareamentos.
- `ConnectionManager.boot()` carrega `peers.first` — não há switcher, mesmo
  com N entradas em storage.
- Decisão antiga (`../../adr/20260518-closed-decisions.md`): "Lifetime do pareamento: até alguém
  revogar. Comando `/remote-pi revoke <nome>` (não no MVP, mas previsto)" +
  "Trabalho paralelo emerge da arquitetura: N Pi processes pareados = N
  sessões no app". Esse plano honra ambas.

Storage dos 2 lados **já suporta N peers** (arrays). É só faltar UX e
slash command do lado Pi.

---

## Perguntas em aberto

Antes de despachar, fechar Q1–Q5. Decisões propostas em **negrito**;
mude se discordar.

### Q1 — Multi-pareamento no app

App pode ter N Pis pareados simultaneamente?

- **A) Sim** (lista em Settings, switcher rápido entre sessões ativas) — proposta
- B) Não (1 só, novo QR substitui anterior) — mais simples mas perde "trabalho paralelo"

> Recomendo A. Já é o modelo conceitual do `../../adr/20260518-closed-decisions.md` ("trabalho
> paralelo emerge da arquitetura: N Pi = N sessões").

### Q2 — Multi-device no Pi

1 Pi pode ter N devices (iPhone + iPad + outro celular) **conectados
simultaneamente**?

- A) Sim, broadcast (mensagens vão pra todos os devices ativos)
- B) Sim, mas só 1 ativo por vez (paired ↔ idle nos outros)
- **C) Não conectado simultaneamente — só 1 device pode estar `paired` no Pi a qualquer momento**; outros pareados ficam dormentes em `peers.json` — proposta

> Recomendo C. Modelo A exige broadcast/fan-out; B exige negociação de
> "device ativo". Ambos complicam a state machine `idle/started/paired`.
> C é o status quo (`_peerChannel` é singleton) + storage já permite
> múltiplos peers conhecidos — basta "primeiro chega, primeiro pareia"
> com troca por desconexão.

### Q3 — Comando de revoke do Pi

Sintaxe pra `/remote-pi revoke`?

- A) Por nome (`/remote-pi revoke "iPhone do Jacob"`) — frágil com aspas
- **B) Por epk-shortid (`/remote-pi revoke aB12CD34`)** + tab completion lista as shortids existentes — proposta
- C) Por índice (`/remote-pi revoke 0`) — frágil quando lista muda

> Recomendo B. shortid (primeiros 8 chars do epk base64) já é o que aparece
> em `_cmdList`/logs. Tab completion enumera os existentes — sem precisar
> digitar nome com espaços.

### Q4 — UX de revoke no app

- **A) Swipe-to-delete na lista + modal de confirmação ("Revogar X?")** — proposta
- B) Bulk select com checkbox
- C) Apenas botão "Revogar tudo"

> Recomendo A. iOS/Android conventional. Modal explica que reconectar
> precisa de novo QR.

### Q5 — Sinalização cross-side

Quando app revoga, o Pi precisa saber **imediatamente**?

- A) Sim — app envia inner `revoke_pair` ao Pi antes de apagar local
- **B) Não — propagação implícita: próxima reconexão do device revogado cai em `error{unknown_peer}`** — proposta (status quo)

> Recomendo B. Mantém princípio antigo ("sem propagação remota, cada lado
> limpa o seu"). Adicionar `revoke_pair` no inner exige round-trip + reply
> com timeout, complicação que não paga. UX no app: avisar
> "Pareamento revogado neste dispositivo. O Mac ainda confia até alguém
> rodar `/remote-pi revoke <id>` lá."

---

## Estrutura esperada (assumindo respostas propostas)

### Inner envelope (sem mudanças)

Plano 08 **não toca em `protocol.md`** — todos os fluxos cabem nos tipos
existentes. `unknown_peer` (já documentado) sinaliza pareamento desfeito.

### App — UI nova em `lib/ui/settings/`

Settings hoje mostra 1 peer só. Reformatar pra lista.

```
ui/settings/
├── settings_page.dart                # Lista de peers + botão "Pair new"
├── states/
│   └── settings_state.dart           # Loading | NoPeer | List(peers, activeEpk)
├── viewmodels/
│   └── settings_viewmodel.dart       # load() | revoke(epk) | switchTo(epk)
└── widgets/
    ├── widgets.dart                  # barrel
    ├── peer_list_item.dart           # tile + dismissible
    └── revoke_confirm_dialog.dart    # modal
```

`SettingsReady` vira `SettingsList{ peers: List<PeerRecord>, activeEpk: String? }`.
`activeEpk` é o peer atualmente no `ConnectionManager`. A UI marca esse com
ícone "ativo" e oferece "Switch" nos outros.

### App — `ConnectionManager` ganha `switchTo`

```dart
Future<void> switchTo(PeerRecord peer) async {
  await disconnect();
  await _connect(peer);
}
```

Trivial — `_connect` já existe; `switchTo` é só sequência. Storage
mantém ordem (peer mais recente primeiro, ou ordenação custom).

### App — fluxo de revoke

```
SettingsList → swipe peer → modal "Revogar X?" 
  → confirm:
    if activeEpk == peer.epk:
      await connectionMgr.disconnect()
    await storage.deletePeer(peer.epk)
    → reload SettingsList
  → cancel: nada
```

### Pi-extension — `/remote-pi revoke <shortid>`

Implementar `_cmdRevoke`:

```typescript
async function _cmdRevoke(arg: string, ctx) {
  const shortid = arg.trim();
  if (!shortid) { ctx.ui.notify("Usage: /remote-pi revoke <shortid>"); return; }
  
  const peers = await listPeers();
  const matches = peers.filter(p => p.remote_epk.startsWith(shortid)
                                 || p.remote_epk.slice(0, 8) === shortid);
  if (matches.length === 0) { ctx.ui.notify(`No peer matching '${shortid}'`); return; }
  if (matches.length > 1)  { ctx.ui.notify(`Ambiguous shortid — multiple matches`); return; }
  
  const peer = matches[0];
  await removePeer(peer.remote_epk);
  
  // Se for o device atualmente pareado, vai pra idle
  if (_state === "paired" && _appPeerId === peer.remote_epk) {
    _goIdle(`Revoked active peer ${peer.name}`);
  }
  
  ctx.ui.notify(`[remote-pi] Revoked: ${peer.name} (${peer.remote_epk.slice(0,8)}…)`);
}
```

Tab completion:

```typescript
getArgumentCompletions: async (prefix) => {
  const peers = await listPeers();
  return peers
    .map(p => p.remote_epk.slice(0, 8))
    .filter(s => s.startsWith(prefix))
    .map(s => ({ value: s, label: `${s} (${peers.find(p => p.remote_epk.startsWith(s))?.name})` }));
}
```

### Pi-extension — `unknown_peer` no `routeClientMessage`

Hoje `routeClientMessage` é chamado **somente quando peer está paired**.
Se um device revogado tentar reconectar, ele cai no auto-listener com
peer desconhecido → ignorado silenciosamente (status quo correto).

Mas se o Pi REVOGOU enquanto o device estava paired e a mensagem já
está em flight: o `_goIdle` desconecta o canal antes da mensagem chegar
no `routeClientMessage`. Idempotente.

**Não há mudança no `protocol.md`.** Comportamento esperado pós-revoke:
- App revoga → próxima reconnect rejeitada com `unknown_peer` (já
  implementado no plano 06, basta UI tratar)
- Pi revoga → device cai pra offline. Próxima reconnect também
  `unknown_peer`.

---

## Passos com critério de aceite

### Wave 0 — Decisões (orquestrador-only)

- [x] Fechar Q1–Q5 acima com o usuário (A-C-B-A-B em 2026-05-19)
- [x] Atualizar `../../adr/20260518-closed-decisions.md` registrando Q1–Q5 fechadas
- [x] (sem mudança em contracts)

### Wave 1 — Subprojetos em paralelo

#### W1.A — pi-extension
- [x] Implementar `_cmdRevoke` real (validação de shortid, dedup, ambiguidade, idle se revogar peer ativo)
- [x] Tab completion enumerando shortids existentes
- [x] Atualizar `_cmdList` pra mostrar shortid + nome + "(active)" se paired com aquele peer
- [x] Testes: revoke shortid válido / inválido / ambíguo / do peer ativo (deve ir pra idle) — 6 testes novos
- [x] Atualizar descrição do `registerCommand("remote-pi revoke", ...)` (tirar "TODO")
- [x] `pnpm typecheck && pnpm build && pnpm test` verde (55 tests)

#### W1.B — app
- [x] Refatorar `SettingsState`: `SettingsList{peers, activeEpk}` em vez de `SettingsReady{peer}`
- [x] Refatorar `SettingsViewModel`: `load()`, `revoke(epk)`, `switchTo(epk)`
- [x] Adicionar `ConnectionManager.switchTo(peer)`
- [x] Refatorar `SettingsPage` pra lista com swipe + modal de confirmação
- [x] Botão "Pair new" no AppBar da Settings → navega pra `/pair`
- [x] Tratamento de `error{code: unknown_peer}` em `SessionRepository`: emite evento que o ChatPage usa pra banner
- [x] `flutter analyze && flutter test` verde (72 tests)
- [x] Cobertura de teste: lista com N peers, switch entre eles, revoke do ativo desconecta, revoke do inativo só apaga

#### W1.C — relay
- [x] **Sem mudança.** Confirme: smoke test (`cargo test`) continua verde (10 tests).

#### W1.D — app: Home screen + nova navegação (adicionada 2026-05-19)

**Motivação**: hoje `/boot` redireciona pra `/chat` se há peer salvo. Com
multi-pairing, isso é confuso — qual dos N peers vira o chat? UX correta
é uma **home** (lista de sessões, estilo WhatsApp) que serve como ponto
de entrada, com tap pra abrir a sessão e botão `+` pra parear novos.

Settings continua existindo, mas vira tela secundária acessível via menu
da home (com foco em revoke/admin).

##### Mudanças de rota

```
ANTES                          DEPOIS
/boot → /chat ou /pair         /boot → /home ou /pair
/chat                          /home          ← lista de sessões (nova)
/pair                          /chat          ← chat do peer ativo
/settings                      /pair
                               /settings      (acessível via menu da home)
```

Redirect:
- `/boot` → `/home` (se há ≥1 peer) ou `/pair` (se nenhum)
- `/home`: tap em peer → `switchTo(peer)` + `context.go('/chat')`
- `/home`: botão `+` no AppBar → `context.go('/pair')`
- `/home`: menu (3 pontos) → `Settings` → `context.go('/settings')`
- `/chat`: AppBar com botão back → `context.go('/home')`

##### Nova feature `lib/ui/home/`

```
lib/ui/home/
├── home_page.dart                    # AppBar + ListView + FAB '+'
├── states/
│   └── home_state.dart               # Loading | NoPeer | List(peers, activeEpk, statusByEpk)
├── viewmodels/
│   └── home_viewmodel.dart           # load, openSession(epk)
└── widgets/
    ├── widgets.dart                  # barrel
    └── session_tile.dart             # avatar + name + status dot + last activity
```

`HomeState.List` é parecido com `SettingsList` mas com **diferenças semânticas**:

- `statusByEpk`: `Map<String, PeerOnlineStatus>` (online/offline/retrying) — pra
  mostrar dot verde/cinza/amarelo no tile (vem de `ConnectionManager` testando
  cada peer? Ou só do ativo? **Recomendação: só do ativo** — outros ficam "offline"
  por default, MVP). Mais info abaixo.
- Sem swipe-to-delete (revoke fica na Settings — home foca em conversar)
- Tile maior, mais visual; avatar circular (inicial do nome ou ícone)

##### `HomeViewModel`

```dart
class HomeViewModel extends ViewModel<HomeState> {
  HomeViewModel(this._storage, this._conn) : super(const HomeLoading()) {
    _load();
    _statusSub = _conn.statusStream.listen((_) => _refreshActive());
  }

  Future<void> _load() async { /* like SettingsViewModel */ }

  Future<void> openSession(String epk) async {
    final peers = await _storage.listPeers();
    final target = peers.firstWhereOrNull((p) => p.remoteEpk == epk);
    if (target == null) return;
    await _conn.switchTo(target);
    // chamador navega pra /chat após o switch
  }
}
```

##### Status dot por peer — MVP simples

- Peer ativo: status real do `ConnectionManager` (online/retrying/offline)
- Peers inativos: sempre "offline" (cinza)
- **Não** vamos abrir conexões em paralelo só pra colorir os tiles — desperdício
  de bateria. Se o user quer ver se um peer está online, basta tocar nele
  (vira ativo, conecta, status atualiza).

##### Botão `+` e onboarding

- AppBar trailing: ícone `+` → `/pair`
- Quando `HomeState.NoPeer` (todos revogados ou primeira vez): card central com
  CTA "Escanear QR" + ícone (mesma UX do empty state da Settings hoje)

##### Routing e injeção

- Atualizar `lib/routing/app_router.dart`: adicionar rota `/home`, mudar redirect
- Adicionar `_injector.addViewModel<HomeViewModel>(HomeViewModel.new)` em `config/dependencies.dart`
- Adicionar `ViewmodelProvider<HomeViewModel>()` no `MultiProvider` da rota `/home`
- Atualizar `/chat`: AppBar com botão back → `/home` (em vez de pop)
- Atualizar `PairingViewModel`: após `pair_ok`, navegar pra `/home` (em vez de `/chat` direto) — usuário escolhe se quer abrir a sessão imediatamente ou ver lista

##### Tarefas W1.D

- [x] Criar `lib/ui/home/` com states/viewmodels/widgets/page
- [x] `HomeViewModel.openSession(epk)` chamando `ConnectionManager.switchTo`
- [x] `SessionTile` com avatar (inicial), nome, sessionName secundário, dot de status
- [x] Atualizar `lib/routing/app_router.dart`: nova rota `/home`, redirect mudado
- [x] Atualizar `config/dependencies.dart` injetando `HomeViewModel`
- [x] `ChatPage` AppBar: botão back navega pra `/home`
- [x] `PairingViewModel` (ou `PairingPage`): após `pair_ok`, redireciona pra `/home`
- [x] Menu da Home (3-dots) com item "Settings" → `/settings`
- [x] Testes: `test/ui/home/home_viewmodel_test.dart` — load, openSession (chama switchTo), refresh on status stream (6 tests)
- [x] `flutter analyze && flutter test` verde (78 tests)
- [x] Fix dívida conhecida: back do `/settings` faz `context.pop()` mas a rota é alcançada via `context.go`, então pilha vazia → splash. Trocar pra `context.go('/home')`

### Wave 2 — Roundtrip manual multi-pairing

**Pré-requisito**: W1.A, W1.B, W1.C e **W1.D** mergeadas + apps reiniciados.

- [ ] Boot fresh: app abre direto em `/home` com lista de peers (não `/chat`)
- [ ] Tap em peer ativo → vai pra `/chat` daquele peer
- [ ] AppBar do `/chat` tem botão back que volta pra `/home`
- [ ] Tap no `+` na `/home` → vai pra `/pair`
- [ ] Após pareamento bem-sucedido, redireciona pra `/home` (não direto pro chat)
- [ ] Parear app com Pi A (cwd_a)
- [ ] Encerrar `/remote-pi stop` em A, abrir Pi B em cwd_b, parear
- [ ] `/home` mostra 2 peers; Pi B ativo (dot verde)
- [ ] Tap em Pi A → switchTo → /chat de Pi A (dot verde migra)
- [ ] Voltar pra `/home` → menu 3-dots → Settings
- [ ] Settings (já refeita em W1.B): swipe Pi A → modal → revogar → lista vazia? Não — só sobra Pi B
- [ ] Voltar pra `/home`: agora só Pi B
- [ ] No Pi B: `/remote-pi list` mostra o app (com `(active)`)
- [ ] No Pi B: `/remote-pi revoke <shortid>` → app recebe error{unknown_peer} → banner no /chat

### Wave 3 — Polish

- [ ] Decisão fechada em `../../adr/20260518-closed-decisions.md` (mover Q1–Q5 pra "fechadas")
- [ ] Atualizar `README.md`: parágrafo "Multi-pareamento" descrevendo modelo
- [ ] Commit cobrindo plano 08

---

## Definition of Done

- [x] Q1–Q5 fechadas
- [x] W1.A pi-ext: `/remote-pi revoke <shortid>` funcional + tab completion + testes
- [x] W1.B app: Settings com lista, switcher, revoke por swipe, banner unknown_peer
- [x] W1.C relay: smoke verde
- [x] Fix pi-ext: auto-listener emite `error{unknown_peer}` pra peers desconhecidos não-`pair_request`
- [ ] W1.D app: Home screen + nova rota + ChatPage/PairingPage redirecionando pra /home
- [ ] W2: roundtrip manual multi-pairing 100% (com nova UX de home)
- [ ] W3: 00-decisions atualizado + README atualizado + commit

---

## Próximos planos

- **`plan/07-relay-deploy.md`** — adiada por decisão do usuário (final do roadmap)
- **`plan/09-e2e-restore.md`** *(opcional)* — religar Noise XX
- **`plan/10-push-notifications.md`** *(v2)* — APNs/FCM pra approvals chegarem mesmo com app fechado

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Switch entre peers fica lento (`disconnect → connect`) | Aceitar latência inicial; otimização (canal paralelo) só se sentir incômodo |
| User revoga peer ativo e UI fica em estado inconsistente | `SettingsViewModel.revoke(epk)` checa se é ativo e chama `disconnect()` antes do `deletePeer` |
| 2 devices tentam parear no Pi ao mesmo tempo (race no `idle → paired`) | Pi tem `_state` singleton — segundo `pair_request` recebido enquanto primeiro processa cai em `pair_error{token_consumed}` naturalmente. Idempotente |
| Pi revoga peer mas peers.json fica corrompido se gravação falhar | `removePeer` já é atomic (file rewrite). Se quiser robustez, escrever em `.tmp` + rename, mas overkill MVP |
| Usuário fica confuso entre "ativo" vs "pareado" | Settings UI marca ativo com ponto verde + texto "Ativo agora". Modal explica diferença |
| Bug 49 (duplo-disparo do app) ressurge com `switchTo` | `disconnect()` cancela canal antigo via `CancelToken` antes de novo `_connect` — pattern já validado no Wave 2 do plano 06 |
