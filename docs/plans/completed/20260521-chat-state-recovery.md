> **历史归档。** 原始路径：`plan/13-chat-state-recovery.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 13 — Chat state recovery (NoPeer no bootstrap)

## Contexto

Pós-plano 12 + fix de encoding (presence funcionando), bug remanescente:

- Home mostra peer **online** (dot verde via presence)
- User tap → entra no Chat
- `ChatViewModel._bootstrap` recebe `SessionState.connection = StatusNoPeer`
- `_toChat` mapeia (NoPeer + bootstrapping=true) → `ChatConnecting`
- Fica em "Connecting…" eterno porque ConnectionManager nunca sai do `StatusNoPeer`

User confirmou: "no bootstrap do chat está vindo NoPeer".

## Análise estrutural

A arquitetura atual tem **3 fontes assíncronas** que precisam alinhar antes do chat ficar pronto:

1. **`ConnectionManager.boot()`** — fire-and-forget em `app_router.dart:34`, conecta `peers.first` (não necessariamente o peer que o user quer abrir)
2. **`Preferences.selectedPeerEpk`** — setado pelo `HomeViewModel.openSession` quando user tap. Pode ainda não estar persistido quando ChatViewModel monta
3. **`ChatViewModel._bootstrap`** — lê selectedPeerEpk, chama `openSession(peer)` → `switchTo(peer)`. Idempotente se peer já ativo

### Cenários de quebra identificados

**Cenário A** — peer.first ≠ selectedPeerEpk:
```
boot() → connect(peers.first=A)         [in progress, status=Connecting]
user tap peer B → setSelectedPeerEpk(B)
nav /chat → ChatViewModel monta
  _bootstrap → peer = B
  → openSession(B) → switchTo(B):
    activePeer=A, status=Connecting → NOT idempotent
    → disconnect() → emit StatusNoPeer
    → _connect(B) → emit StatusConnecting → factory racing com boot()
  → _onSession(_repo.current) → conn pode ser NoPeer (race no disconnect)
  → bootstrapping=true, conn=NoPeer → ChatConnecting
```

**Cenário B** — selectedPeerEpk null:
```
_bootstrap → epk == null → ChatNoPeer
```
(esse não é o sintoma; user vê "Connecting…")

**Cenário C** — boot() ainda não emitiu StatusOnline quando ChatViewModel monta + switchTo idempotente:
```
_conn._status = NoPeer (default) ou Connecting
_conn._activePeer = peer ou null (depende do timing do _connect linha 315)
switchTo(peer): activePeer match mas status != Online → NOT idempotent
→ disconnect() + _connect(peer)
→ paralelo com boot()'s _connect, ambos em race
```

### Causa-raiz comum

**Não há single source of truth pra "qual peer deve estar ativo"**. boot() decide um (peers.first). User decide outro (selectedPeerEpk). Quando divergem, switchTo derruba e refaz. Em algum ponto desse race, ChatViewModel pega seed de NoPeer.

Além disso:
- `disconnect()` emite `StatusNoPeer` antes de reconectar — janela de inconsistência
- `_bootstrapping` flag depende de transição de status, não funciona se status oscila
- `_onSession(_repo.current)` pega snapshot único, sem retry/poll

## Princípio do fix

**Unificar source of truth do peer ativo**: `selectedPeerEpk` (Preferences) vira o **autoritário**. boot() respeita ele. ChatViewModel apenas observa.

Mudanças necessárias:

1. **`ConnectionManager.boot(selectedEpk?)`**: usa `selectedPeerEpk` em vez de `peers.first`. Se null, fallback pra `peers.first`
2. **`Preferences.selectedPeerEpk` setado no boot inicial** se há ≥1 peer (default = peers.first salvo no Preferences via `_BootState`)
3. **`HomeViewModel.openSession(epk)` chama `_conn.switchTo(peer)` também** (não apenas seta preference)
4. **`ChatViewModel._bootstrap` confia no estado atual** — não chama `switchTo` se já é o peer ativo. Subscreve no statusStream com seed do `_conn.status` direto (síncrono).
5. **`switchTo(peer)` chama `_emit(StatusConnecting)` ANTES de `disconnect()`** — evita janela de NoPeer falsa visível pra ChatViewModel.

## Estrutura esperada

### App (Flutter)

#### `lib/data/preferences/preferences.dart`
- Sem mudança de API
- `_BootState.load` (em `app_router.dart`) seta default se null: `if (selected == null && hasPeer) await prefs.setSelectedPeerEpk(peers.first.remoteEpk)`

#### `lib/data/transport/connection_manager.dart`
- `boot()` ganha parâmetro opcional `String? preferredEpk`:
  ```dart
  Future<void> boot({String? preferredEpk}) async {
    if (_activePeer != null) { /* subscribe replay e return */ }
    if (_status is StatusOnline) return;
    final peers = await _storage.listPeers();
    if (peers.isEmpty) { _emit(NoPeer); return; }
    _subscribedEpks = peers.map((p) => p.remoteEpk).toList();
    final target = preferredEpk != null
        ? peers.firstWhere((p) => p.remoteEpk == preferredEpk, orElse: () => peers.first)
        : peers.first;
    await _connect(target);
  }
  ```
- `switchTo(peer)`:
  - Antes do disconnect, emit `StatusConnecting` (sinaliza transição). Disconnect ainda vai limpar internamente mas o emit visível pula direto pra Connecting
  - OU melhor: refatorar pra não emitir NoPeer no disconnect quando vai ser seguido por connect. Adicionar parâmetro `_disconnectInternal(emitNoPeer: bool)`

#### `lib/routing/app_router.dart`
- `_BootState.load`: depois de `peers = await storage.listPeers()`:
  ```dart
  if (peers.isNotEmpty) {
    await prefs.load(); // garantir carregado
    final selected = prefs.selectedPeerEpk ?? peers.first.remoteEpk;
    if (prefs.selectedPeerEpk == null) {
      await prefs.setSelectedPeerEpk(selected);
    }
    await conn.boot(preferredEpk: selected);
  }
  ```
- Esperar boot() retornar antes de navegar? Considerar trade-off — pode atrasar /home aparecer. Sugestão: fire-and-forget igual hoje, mas garantir que boot() **sempre escolhe** o peer certo (não peers.first)

#### `lib/ui/home/viewmodels/home_viewmodel.dart`
- `openSession(epk)`:
  ```dart
  Future<void> openSession(String epk) async {
    final peers = await _storage.listPeers();
    final target = peers.firstWhereOrNull((p) => p.remoteEpk == epk);
    if (target == null) return;
    await _prefs.setSelectedPeerEpk(epk);
    await _conn.switchTo(target); // GARANTIR conexão pro peer escolhido
  }
  ```

#### `lib/ui/chat/viewmodels/chat_viewmodel.dart`
- `_bootstrap`:
  - Removida a chamada a `openSession` se peer já é o ativo (evita switchTo redundante)
  - Em vez de `_onSession(_repo.current)`, seedar com seed do `_conn.status`:
    ```dart
    final currentStatus = _conn.status; // getter sync
    _onSession(SessionState(connection: currentStatus, messages: ...));
    ```
  - Better: ChatViewModel recebe ConnectionManager (já recebe via repo) e checa direto
- `_toChat` mais resiliente: se `bootstrapping && (StatusNoPeer || StatusConnecting)`, ainda mostra ChatConnecting MAS aceita transição StatusConnecting → StatusOnline em ms

### Relay
- **Sem mudança.** Bug é puramente do app.

### Pi-extension
- **Sem mudança.**

## Passos

### Wave 0 — Diagnóstico final (orquestrador-only)
- [ ] Pedir ao user 1 log completo com [conn] + [chat-state] do fluxo: boot app + tap peer + entra chat. Confirma qual cenário (A/B/C) está rolando

### Wave 1 — Fix arquitetural (1 despacho App)
- [ ] `ConnectionManager.boot({preferredEpk})` honra selectedPeerEpk
- [ ] `_BootState.load` seta default selectedPeerEpk se null + passa pra boot()
- [ ] `HomeViewModel.openSession` chama `_conn.switchTo(peer)` explicitamente
- [ ] `ChatViewModel._bootstrap` confia em estado atual (não dispara switchTo redundante)
- [ ] `switchTo`: não emite NoPeer transiente (refatorar disconnect interno)
- [ ] Tests:
  - 'boot(preferredEpk) conecta no peer certo (não peers.first)'
  - 'openSession set preference + switchTo'
  - 'ChatViewModel pega seed sync sem precisar de evento futuro'
  - 'switchTo entre peers nunca emite NoPeer visível (vai direto Connecting)'

### Wave 2 — QA manual
- [ ] App fresh boot, 2 peers pareados, ambos online: entrada na home → tap peer A → chat carrega imediato (sem connecting)
- [ ] Voltar pra home → tap peer B → chat carrega imediato pra peer B
- [ ] Reabrir app (kill total): vai direto pro chat do último peer escolhido (selectedPeerEpk)
- [ ] Pi offline: tap peer cinza → chat com banner amber + histórico cache (Opção C do fix anterior)

### Wave 3 — Polish
- [ ] Atualizar `../../adr/20260518-closed-decisions.md`: registrar "Preferences.selectedPeerEpk é fonte autoritária do peer ativo"
- [ ] Atualizar `chat_viewmodel.dart` comentários sobre seed sync

## Definition of Done

- [x] Wave 0: log analisado, cenário confirmado (Cenário A do plano)
- [x] Wave 1: fix mergeado, testes verdes (139 tests, +8)
- [ ] Wave 2: 4 cenários manuais OK
- [ ] Wave 3: docs

## Próximos planos

- **Plano 14+** — features novas após estabilidade
- **Plano 07** — relay deploy (com lembrete de throttle/jitter env vars na memória)
