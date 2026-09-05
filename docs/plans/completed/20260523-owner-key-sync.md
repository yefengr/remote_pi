> **历史归档。** 原始路径：`plan/23-owner-key-sync.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 23 — Owner-key sincronizada via Keychain nativa

Objetivo: substituir o modelo "uma chave Ed25519 por device" pelo modelo "uma chave Ed25519 por humano, sincronizada via mecanismo nativo do ecossistema". Resolve as três dores levantadas em conversa:

1. **Perdeu o aparelho** → outro device do mesmo Apple ID / conta Google já tem a chave + lista de pareamentos.
2. **Trocou de celular** → restore do device traz a Keychain sincronizada; app abre conectado.
3. **Quer usar iPhone + iPad** → mesma chave em ambos, ambos aparecem online simultaneamente do lado Pi.

Este plano **não** propõe E2E, não usa Secure Enclave (incompatível com sync), não tem export BIP-39, não cobre cross-ecossistema. Tudo isso é roadmap aditivo.

---

## Contexto

Hoje (`app/lib/pairing/storage.dart`):
- `DeviceIdentity` Ed25519 gerada em `loadOrCreateDeviceEd25519Key()`, salva em `flutter_secure_storage` sob `dev.remotepi.device:ed25519`. Singleton por instalação.
- `PeerRecord` por pareamento, salvo em `flutter_secure_storage` sob `dev.remotepi.peers:<remote_epk>`.
- Nada sincroniza entre devices do mesmo humano.

Hoje (`pi-extension/src/pairing/storage.ts`):
- `peers.json` indexado por `remote_epk` (pubkey do app pareado). Um humano com 2 devices = 2 entries distintas hoje.
- Pi-extension não distingue "humano" de "device" — só conhece pubkeys.

Hoje (`relay/src/peers/registry.rs`, plan 17):
- HashMap indexado por `(peer_id, room_id)`. Aceita N rooms por peer. Rejeita segunda conexão com mesmo `(peer, room)` com `room_already_open`.
- Relay continua stateless. Plan 23 **não** muda o relay.

---

## Decisões fixadas neste plano

| Decisão | Valor |
|---|---|
| Granularidade | Chave única por humano. Pi vê 1 peer por humano, não 1 por device. Aceita perda de revoke-por-device e presence-por-device (conscientemente) |
| Sync | Plataforma nativa: iCloud Keychain (iOS) + Block Store (Android). Sem Secure Enclave. Lock-in de ecossistema aceito |
| Curva | Mantém Ed25519. Chave gerada em Dart (`cryptography`) e persistida como blob arbitrário — não usa `SecKey`/`KeyStore` como key-handle |
| Cross-ecossistema | Não suportado nesta versão. Sem export BIP-39. Sem migração iPhone→Android |
| O que sincroniza (escopo do plugin) | **Apenas o Owner Ed25519 keypair (64 bytes).** Plugin tem responsabilidade única: persistir a chave no storage sincronizado da plataforma. Gestão de peers (lista de Pis pareados, revogação, propagação entre devices) é responsabilidade de **outra camada** — provavelmente `mesh_versions` no relay (plan/24 em discussão). Renames/nicknames seguem locais |
| Fan-out | Client-side no Pi via `subscribe_rooms` + `room_announced`/`room_ended` push (já existe no relay). Relay não ganha lógica nova |
| `room_id` do lado app | Derivado de UUID local persistente (gerado na primeira abertura, salvo em storage não-sincronizado). Garante `(peer_id, room_id)` único entre devices do mesmo humano |
| Plugin Flutter | Novo package em `app/packages/remote_pi_identity/`, com interface Dart + impl iOS (Swift) + Android (Kotlin) via MethodChannel |
| Migração | **Nenhuma.** Projeto pré-release, sem código legacy a preservar. `DeviceIdentity` atual é simplesmente substituída por `OwnerIdentity` no refactor |
| Imutabilidade da Owner-key | A chave é gerada **uma vez** e nunca rotaciona. Sem versionamento de schema. Se `watch()` traz uma chave diferente da local (cenário: usuário fez reset em outro device), aceita a nova como autoritativa — trata como "começou do zero". Sem prompt, sem reconciliação |
| Sync no Android | **Block Store apenas** (resolve P1 recovery + P2 troca de device). P3 simultâneo (iPhone+iPad live) **é iOS-only no MVP.** Android sem live sync entre devices ativos — fallback é re-pairing manual. Credential Manager / passkey adiado pra `plan/26-android-live-sync.md` eventual |
| Comportamento sem sync disponível | **Bloqueia primeira abertura** com mensagem clara. iOS: "Ative iCloud Keychain em Ajustes > [seu nome] > iCloud > Senhas e Chaves." Android: "Ative o Backup do Google em Ajustes > Sistema > Backup." Sem fallback "gera local" pra evitar divergência silenciosa com sync futuro |
| **Versão mínima iOS** | **iOS 26.0** — todo o ecossistema Apple suportado pelo Remote Pi é 26+. Permite usar APIs Keychain/CryptoKit modernas sem fallback. Trade-off: corta base de iOS 17/18, aceito conscientemente em favor de código mais limpo |
| **Versão mínima Android** | **API 34 (Android 14)** como `minSdk`. Permite Credential Manager estável (futuro), Material 3 completo, biometria moderna, themed icons. Block Store funciona desde API 23 — versão alta não muda Block Store em si, mas mantém código de plataforma enxuto |
| **Versão Flutter** | Flutter 3.41+ / Dart 3.11+ (mantém o que o app já usa) |

---

## Decisões a fechar antes da Wave 1

- **Q4 — Limites de tamanho.** Block Store no Android é ~1KB. Cabe ~10-15 peers com base64 + metadata. Estratégia quando estourar: compressão gzip? Múltiplos blobs por bucket? Cap em N peers? Eventualmente impactado pela decisão sobre "servidor próprio pra storage" (em discussão).

---

## Estrutura final esperada

```
remote_pi/
├── app/
│   ├── packages/
│   │   └── remote_pi_identity/              ← novo plugin (passo 1)
│   │       ├── lib/
│   │       │   ├── remote_pi_identity.dart
│   │       │   └── src/
│   │       │       ├── owner_identity.dart
│   │       │       ├── owner_identity_store.dart
│   │       │       └── method_channel_store.dart
│   │       ├── ios/
│   │       │   └── Classes/RemotePiIdentityPlugin.swift
│   │       ├── android/
│   │       │   └── src/main/kotlin/.../RemotePiIdentityPlugin.kt
│   │       ├── test/
│   │       └── pubspec.yaml
│   ├── lib/pairing/
│   │   ├── storage.dart                     ← refactor (passo 2)
│   │   └── owner_identity_bridge.dart       ← novo: hidrata storage do plugin
│   ├── lib/transport/
│   │   └── relay_client.dart                ← `room_id` deriva de UUID (passo 3)
│   └── lib/config/utils/
│       └── device_id.dart                   ← novo: UUID local persistente
├── pi-extension/
│   └── src/transport/
│       └── peer_channel.ts                  ← fan-out por peer (passo 4)
│   └── src/session/
│       └── room_tracker.ts                  ← novo: cacheia rooms ativas por peer
└── plan/23-owner-key-sync.md                ← este arquivo
```

---

## Wave 1 — Plugin Flutter `remote_pi_identity` (standalone)

**Estratégia**: criar o plugin como package **isolado**, com **example app próprio**, sem tocar em `app/lib/` ainda. Objetivo desta wave é entregar o plugin funcional + provar que sync funciona em devices reais, antes de integrar no app. Depois desta wave, fazemos análise antes de avançar.

**Localização**: `app/packages/remote_pi_identity/`

**Estrutura esperada**:

```
app/packages/remote_pi_identity/
├── lib/
│   ├── remote_pi_identity.dart            # barrel: exporta API pública
│   └── src/
│       ├── owner_identity.dart            # data class + (de)serialização
│       ├── owner_identity_store.dart      # interface abstrata
│       ├── method_channel_store.dart      # impl via MethodChannel
│       └── in_memory_store.dart           # impl pra testes/fakes
├── ios/
│   ├── remote_pi_identity.podspec
│   └── Classes/
│       ├── RemotePiIdentityPlugin.swift   # registra method channel
│       └── KeychainSyncStore.swift        # impl com kSecAttrSynchronizable
├── android/
│   ├── build.gradle
│   └── src/main/kotlin/dev/remotepi/identity/
│       ├── RemotePiIdentityPlugin.kt      # registra method channel
│       └── BlockStoreStore.kt             # impl com Block Store
├── example/
│   ├── lib/main.dart                       # app demo: load / save / watch / delete
│   ├── ios/Runner.xcodeproj/                # iOS 26 mínimo
│   ├── android/app/build.gradle             # minSdk 34
│   └── pubspec.yaml
├── test/
│   ├── owner_identity_test.dart            # serialização
│   └── in_memory_store_test.dart           # smoke
├── pubspec.yaml
├── CHANGELOG.md
└── README.md
```

### API Dart (pública)

```dart
class OwnerIdentity {
  final Uint8List ownerPk;     // Ed25519 pubkey (32B)
  final Uint8List ownerSk;     // Ed25519 privkey (32B)

  Uint8List toBlob();                       // serialização canônica (64B fixos)
  static OwnerIdentity fromBlob(Uint8List); // throws on malformed
}

/// Erro lançado quando o storage sincronizado não está disponível
/// (iCloud Keychain desligado, conta Google sem backup, etc).
sealed class IdentityStoreError implements Exception {
  factory IdentityStoreError.syncUnavailable(String reason) = SyncUnavailable;
  factory IdentityStoreError.platform(String code, String message) = PlatformFailure;
}

abstract class OwnerIdentityStore {
  /// Returns null on first run. Throws IdentityStoreError if sync unavailable.
  Future<OwnerIdentity?> load();

  /// Persists identity and triggers platform sync.
  Future<void> save(OwnerIdentity identity);

  /// Emits when platform sync brings a new value (or first load on cold start).
  Stream<OwnerIdentity> watch();

  /// Wipes identity from synced storage (use sparingly — reset only).
  Future<void> delete();

  /// Indicates whether sync subsystem is currently available.
  /// Used by the app to decide between "block + show config message" vs proceed.
  Future<bool> isSyncAvailable();
}

/// Concrete impl that delegates to platform via MethodChannel.
class MethodChannelOwnerIdentityStore implements OwnerIdentityStore { ... }
```

**Fora do escopo do plugin** (responsabilidade do app/relay, decisão em discussão):
- Lista de peers (Pis pareados)
- Versionamento de membership (`mesh_versions`)
- Propagação de revogação entre devices

### iOS — Swift (impl em `KeychainSyncStore.swift`)

- `kSecClassGenericPassword`, service `dev.remotepi.owner.identity`, account `singleton`
- `kSecAttrSynchronizable = kCFBooleanTrue` (sincroniza via iCloud Keychain)
- `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlock` (acesso após primeiro unlock pós-boot)
- `isSyncAvailable()`: checa se a conta iCloud está logada e Keychain Sync está habilitado via `FileManager.default.ubiquityIdentityToken != nil` e tentativa de leitura de teste
- `watch()`: combinação de
  - `NSUbiquitousKeyValueStore.didChangeExternallyNotification` como sinal de "talvez mudou"
  - poll de leitura da Keychain com debounce (~2s) sempre que retorna foreground
  - emite no Stream apenas se o blob é diferente do último emitido
- **Sem `SecKey` / sem Secure Enclave** — apenas blob de bytes

### Android — Kotlin (impl em `BlockStoreStore.kt`)

- Dependência: `play-services-auth-blockstore:16.x+`
- `BlockstoreClient` via `Blockstore.getClient(context)`
- `storeBytes(StoreBytesData)`:
  - `setBytes(blob)`
  - `setShouldBackupToCloud(true)` — propaga via backup do Google
  - `setKey("dev.remotepi.owner.identity")`
- `retrieveBytes(RetrieveBytesRequest)`:
  - request com a mesma key
  - retorna null se Block Store ainda não tem
- `isSyncAvailable()`:
  - GMS instalado: `GoogleApiAvailability.isGooglePlayServicesAvailable(context) == SUCCESS`
  - Backup do Google ativo (verificável via `BackupManager` ou heurística — Block Store falha graciosamente se não)
  - Screen lock configurado (requisito do Block Store): `KeyguardManager.isDeviceSecure`
- `watch()`: polling em foreground (~5s) — Block Store **não** tem callback de mudança. Sync só acontece em restore de novo device, então em uso normal o `watch()` quase nunca emite (esperado)

### Example app (`example/`)

App Flutter mínimo demonstrando:
- Botão "Generate identity" → gera Ed25519 (usando `cryptography`) + salva via plugin
- Botão "Load identity" → lê via plugin e exibe pubkey + N peers
- Botão "Add fake peer" → adiciona entrada e re-salva
- Botão "Delete" → wipe
- Indicador "Sync available: yes/no" via `isSyncAvailable()`
- Listener no `watch()` que reage a mudanças
- iOS: `Runner.xcodeproj` configurado pra iOS 26
- Android: `app/build.gradle` com `minSdk 34`, `compileSdk 35`+, `targetSdk 35`+

### Versões e configuração de plataforma

**iOS** (`example/ios/Podfile` + `Runner.xcodeproj`):
```ruby
platform :ios, '26.0'
```
- `Info.plist`: nenhuma permissão nova exigida (Keychain sync é silencioso)
- Capability **Keychain Sharing** NÃO é necessária (não compartilhamos com outros apps)
- Entitlement `keychain-access-groups` opcional, default já basta

**Android** (`example/android/app/build.gradle`):
```gradle
android {
    compileSdk 35
    defaultConfig {
        minSdk 34
        targetSdk 35
    }
}
dependencies {
    implementation "com.google.android.gms:play-services-auth-blockstore:16.4.0"
}
```

**Plugin pubspec** (`packages/remote_pi_identity/pubspec.yaml`):
```yaml
environment:
  sdk: ">=3.11.0 <4.0.0"
  flutter: ">=3.41.0"

flutter:
  plugin:
    platforms:
      ios:
        pluginClass: RemotePiIdentityPlugin
      android:
        package: dev.remotepi.identity
        pluginClass: RemotePiIdentityPlugin
```

### Critério de aceite — Wave 1

- [ ] Plugin compila isolado (`cd app/packages/remote_pi_identity && flutter pub get && flutter analyze` passa)
- [ ] Example app compila em iOS (`flutter build ios --no-codesign` no `example/`) com `minIOSVersion = 26.0`
- [ ] Example app compila em Android (`flutter build apk --debug` no `example/`) com `minSdk 34`
- [ ] Testes unitários passam (`flutter test` no plugin) — cobrem serialização e in-memory store
- [ ] Example app rodando em **um** device iOS físico: ciclo `Generate → Save → Reabre app → Load` retorna o mesmo blob
- [ ] Example app rodando em **um** device Android físico: idem
- [ ] (Manual, opcional pra Wave 1) Em **dois** devices iOS físicos do mesmo Apple ID: salvar em A → reabrir B → `Load` em B retorna o blob salvo em A (validação do iCloud Keychain sync)
- [ ] README do plugin documenta API, requisitos (iOS 26 / Android 14), e o requisito de iCloud Keychain ativado / Google Backup ativado
- [ ] CHANGELOG.md com versão inicial `0.1.0`

### Não-objetivos da Wave 1

- **Não tocar `app/lib/`**. Refactor do `DeviceIdentity` é Wave 2.
- **Não implementar fan-out no Pi**. É Wave 3.
- **Não fazer roundtrip com pi-extension/relay**. Wave 1 valida só o plugin isoladamente.
- **Não publicar no pub.dev**. Plugin é interno (`path: ../packages/remote_pi_identity` no app).
- **Não cobrir P3 simultâneo no Android**. Block Store não tem live sync. Documentar essa limitação no README.

---

## Wave 2 — Integração: app (2A) + relay broadcast (2C) em paralelo

Decisão arquitetural fechada (2026-05-23): em vez de UUID por device + fan-out client-side no pi-ext, **relaxamos a invariante "1 conexão por `(peer, room)`" no relay**. Relay passa a aceitar N conexões no mesmo par e fazer broadcast quando entrega.

Razão: a invariante era conservadora (herança do modelo 1-device-por-peer pré-rooms). Não tem proteção de segurança real — quem ocupa o slot precisa passar challenge-response com a Owner-sk, então já É a identidade legítima. Reabre formalmente a decisão 08-Q2 que já estava obsoleta desde plan 17.

Consequência: Wave 2 fica **muito menor e mais simples** que a alternativa UUID+fan-out. Pi-extension não muda.

### Wave 2A — App: integração do plugin

**Localização**: `app/lib/`

**Mudanças**:
- Adiciona dependência local: `remote_pi_identity` em `app/pubspec.yaml` via `path: packages/remote_pi_identity`
- `OwnerIdentityStore` registrado no `auto_injector` (`config/dependencies.dart`)
- **Remove `DeviceIdentity`** de `app/lib/pairing/storage.dart`. Owner-key vem de `OwnerIdentityStore.load()`. Sem migração — projeto pré-release.
- Onde a Ed25519 sk era usada (challenge-response do relay), passa a usar a Owner-sk do plugin
- **Onboarding**:
  - Verifica `OwnerIdentityStore.isSyncAvailable()` na primeira abertura
  - `false` → bloqueia com tela explicativa específica por plataforma (iOS: "Ative iCloud Keychain em Ajustes…"; Android: "Ative Backup do Google em Ajustes…")
  - `true` + `load()` retorna `null` → gera Owner-key + salva via plugin
  - `true` + `load()` retorna identity → usa direto
- Listener em `OwnerIdentityStore.watch()` na inicialização: se sync trouxer Owner-key diferente da atual em memória, trata como reset (limpa `PairingStorage` local e re-hidrata)
- **Lista de peers continua local** em `PairingStorage` (`flutter_secure_storage` sem `synchronizable`). Re-pareamento manual ao trocar de device é trade-off aceito explicitamente nesta wave. Sync de peers fica pra mesh_versions (plan/24, em discussão).
- **`room_id` mantém `'main'` hardcoded** — broadcast no relay resolve sem UUID.

**Critério de aceite**:
- App compila + `flutter analyze` zero issues + `flutter test` passa
- Primeira abertura em iOS 26 device: gera Owner-key + persiste via plugin
- Mesma app em segundo device do mesmo Apple ID: lê identidade do iCloud, abre conectado com mesma identidade
- Re-pareamento manual em Pi: Pi vê `remote_epk` = Owner-pk já conhecido → não duplica entrada no `peers.json`
- Tela de bloqueio aparece em device sem iCloud Keychain ativado

### Wave 2C — Relay: broadcast por par

**Localização**: `relay/src/`

**Mudanças em `peers/registry.rs`**:
- `senders: Mutex<HashMap<RoomKey, ConnEntry>>` → `Mutex<HashMap<RoomKey, Vec<ConnEntry>>>`
- `register()`: em vez de retornar `Err(())` em chave duplicada, adiciona ao `Vec`. Lógica de `is_first_room` continua marcando "primeira room daquele peer" pra disparar `peer_online` só uma vez.
- `unregister()`: remove conn específica pelo `conn_id` do Vec; quando Vec esvazia, remove a entry inteira do HashMap. `room_ended` dispara quando Vec esvazia (não quando uma conn sai sozinha).
- `forward()` ganha parâmetro `from_conn_id: u64`. Itera o Vec e envia pra cada tx onde `conn_id != from_conn_id` (skip-sender pra evitar eco).
- `rooms_of()`, `is_online()`, `update_room_meta()`: ajustar pra iterar Vec.

**Mudanças em `handlers/peer.rs`**:
- Onde chama `registry.forward(...)`, passa próprio `conn_id` como `from_conn_id`.
- Remove o frame de erro `room_already_open` — não acontece mais.

**Testes**:
- Inverter `duplicate_room_rejected` → `duplicate_room_accepted_and_broadcast`
- Novo: duas conn no mesmo `(peer, room)`, forward com `from_conn_id=A` → só B recebe
- Novo: três conn no mesmo `(peer, room)`, uma desconecta, broadcast funciona pras duas restantes
- Ajustar `two_rooms_same_peer_both_accepted` e `stale_unregister_is_noop`

**Critério de aceite**:
- `cargo build` passa
- `cargo clippy -- -D warnings` passa
- `cargo test` passa, com testes novos cobrindo broadcast
- Docstrings do `PeerRegistry` atualizadas explicando o novo modelo
- README do relay (seção de comportamento) atualizado se mencionar a invariante antiga

### Trade-offs explícitos da Wave 2

- **Reconexão duplicada acidental** (mesma conn reconecta sem fechar a antiga): hoje força limpeza via `room_already_open`. Sem isso, conn velha fica recebendo broadcasts órfãos até heartbeat (25-50s) matar. Mitigação: cliente sempre fecha WS velho antes de reconectar.
- **Audit "qual device fez X" via relay desaparece** ainda mais. Já era difícil; agora é impossível pelo relay. Se precisar no futuro, adicionar `client_id` opcional no envelope (não está no escopo).
- **Sem live sync de lista de peers**: re-pareamento manual ao trocar de device aceito. Sync vem com mesh_versions (plan/24).

### Wave 2D — Pi-extension (zero mudança)

Pi-extension não é tocado nesta wave. Envia `{peer: OwnerPK, ct}` como hoje (default `room: 'main'`). Relay broadcast pra todas as conn nesse par. Múltiplos devices do mesmo Owner recebem cópia.

---

## Wave 3 (futura, em aberto) — sync de membership

Se/quando `plan/24-mesh-sync.md` (em discussão) for aprovado, traz:
- `mesh_versions` assinada no relay (SQLite)
- App publica nova versão ao adicionar/remover peer; Owner-sk assina
- pi-ext busca proativamente e fecha conexão se foi revogado
- iPad novo do mesmo Apple ID baixa lista de peers automaticamente

Esta wave existe pra resolver: sync automático da lista de peers entre devices, revogação propagada (PC offline ainda fica seguro quando voltar), e auditoria de membership.

Não é dependência da Wave 2 — pode ser planejada e despachada separadamente quando dor justificar.

---

## Wave 4 — Roundtrip end-to-end (após Wave 2 + opcionalmente Wave 3)

Cenário completo: iPhone pareado com Pi-A e Pi-B; iPad mesmo Apple ID instala app, baixa Owner-key via iCloud; **com Wave 2 só**: re-pareia Pi-A e Pi-B manualmente; **com Wave 3 também**: peers chegam automaticamente. Mensagens do Pi chegam simultaneamente em ambos os devices via broadcast no relay.

---

## Definition of Done

### Wave 1 — Plugin standalone
- [x] Q1, Q2, Q3, Q5 fechadas
- [x] Q4 trivialmente resolvida (blob 64 bytes — sem cap/compressão necessária)
- [x] Plugin `remote_pi_identity` criado em `app/packages/remote_pi_identity/`
- [x] `flutter analyze` e `flutter test` passam no plugin (17 testes verdes após trim)
- [x] Builds compilam: `flutter build ios --no-codesign` + `flutter build apk --debug` no example
- [x] README do plugin documenta API + requisitos de plataforma + limitações conhecidas
- [x] CHANGELOG.md versão 0.2.0 (trim pós-Wave 1.5)
- [x] **Validação manual** — completa e funcional em devices físicos (iOS 26 + Android 14)

### Wave 2A — App: integração do plugin
- [x] `DeviceIdentity` removido por completo
- [x] `OwnerIdentityStore` registrado via `auto_injector`
- [x] Owner-sk usada pra challenge-response do relay
- [x] Onboarding bloqueia primeira abertura quando `isSyncAvailable() == false`
- [x] `watch()` listener trata "Owner-key trocada via sync" como reset local
- [x] `PairingStorage` continua local (peers não sincronizam nesta wave)
- [x] `room_id: 'main'` mantido — broadcast no relay resolve

### Wave 2C — Relay: broadcast por par
- [x] `senders` vira `HashMap<RoomKey, Vec<ConnEntry>>`
- [x] `register()` aceita N conexões no mesmo par
- [x] `forward()` ganha `from_conn_id` e faz skip-sender
- [x] `unregister()` remove por `conn_id`, limpa entry quando Vec esvazia
- [x] Frame `room_already_open` removido do handler
- [x] Testes: novos casos de broadcast + skip-sender + ajustes nos existentes (36 testes verdes)
- [x] `cargo clippy -- -D warnings` passa
- [x] Docstrings + README do relay refletem novo modelo

### Wave 3 (futura, em aberto) — mesh_versions / sync de peers
- [ ] Decisão sobre `plan/24-mesh-sync.md` fechada
- [ ] (Se aprovado) implementado e validado

### Wave 4 — Roundtrip end-to-end
- [x] Cenário completo passa em devices físicos iOS
- [x] Dois devices do mesmo Apple ID conectados simultaneamente, ambos veem mensagens do Pi via broadcast
- [x] `../../adr/20260518-closed-decisions.md` atualizado: 08-Q2 marcada como revisada com referência a este plano

---

## Não-objetivos (explícitos)

- **Sem Secure Enclave / StrongBox**. Chave é blob na Keychain padrão sincronizada. Trade-off aceito.
- **Sem cross-ecossistema**. Nasceu Apple, fica Apple. Nasceu Android, fica Android.
- **Sem revoke por device**. Revoke é da Owner-key inteira (regenera e re-pareia tudo).
- **Sem export BIP-39 / mnemônica**. Recovery depende inteiramente do sync da plataforma. Se o usuário perder o único device sem segundo aparelho no Apple ID e também perder a conta Apple, perde tudo. Aceito como trade-off.
- **Sem mudança no relay**. Zero linhas em `relay/`.

---

## Próximos planos

- **`plan/24-key-recovery-export.md`** (eventual) — adicionar export BIP-39 como camada complementar pra usuário que quer soberania total ou cross-ecossistema. Só se aparecer dor real.
- **`plan/25-per-device-identity.md`** (eventual) — se "perda de granularidade" virar dor (revoke seletivo, audit por device, presence por device), implementar modelo Owner-assina-sub-keys preservando UX deste plano.
