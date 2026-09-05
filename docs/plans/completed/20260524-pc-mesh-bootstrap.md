> **历史归档。** 原始路径：`plan/25-pc-mesh-bootstrap.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 25 — PC-mesh bootstrap: cross-PC session routing

Objetivo: estender o **broker UDS local** (plano/19) pra alcançar sessões em **outros PCs do mesmo Owner**, usando o relay como transporte de envelopes Pi-to-Pi. Quando o PC-A precisa falar com uma sessão, ele decide entre UDS (local) ou relay forward (remoto) de forma transparente — o envelope é o mesmo.

Esta é a **terceira pavimentação** da visão PC-mesh:
- plan/23 = Owner-key cross-device (identidade compartilhada)
- plan/24 = mesh_versions assinada (cartório de membership)
- **plan/25 (este) = sessões cross-PC via envelope forwarding**

PC-to-PC direto (WebRTC/QUIC) continua fora do escopo. Relay é o único transporte cross-PC nesta rodada.

---

## Pré-existências que tornam isso barato

| Peça | Onde | O que faz |
|---|---|---|
| Broker UDS local | `pi-extension/src/session/broker.ts` | Aceita peers locais via UDS; roteia envelope `{from, to, id, re, body}`; já tem `list_peers`, `peer_joined`, `peer_left`, `broadcast` |
| Envelope JSONL | `pi-extension/src/session/envelope.ts` | Schema imutável de 5 campos; UUID v7 ordenável por tempo |
| Leader election | `pi-extension/src/session/leader_election.ts` | Um broker por máquina (vencedor da CWD lock) |
| Multi-Pi no app | já operável em produção | App tem N pareamentos com PCs distintos; vê sessões de cada |
| mesh_versions assinada | `relay/src/mesh/` + `app/lib/data/mesh/` | Relay sabe que Pi-A e Pi-B pertencem ao mesmo Owner (membership verificável via Ed25519) |
| WS Pi↔Relay autenticada | `relay/src/handlers/peer.rs` + `pi-extension/src/transport/relay_client.ts` | Cada Pi já tem canal vivo com o relay; auth por Pi-pubkey |

**O que falta**: dar ao broker um segundo "tipo de peer" (peers remotos, atingíveis via relay) e ao relay uma rota nova de "envelope forward entre Pis-irmãos".

---

## Insight central

O `Broker._resolveTargets(env)` hoje resolve `env.to` no map local de peers UDS. Pra cross-PC, basta:

1. **Naming**: introduzir endereço composto `<pc_label>:<peer_name>` (ex.: `casa:sess-3`). PC local resolve `pc_label == self` → UDS; `pc_label != self` → relay forward
2. **Inventário**: cada PC publica seu `peerNames()` pra Pis-irmãos via relay. Broker local mantém cache `remotePeers: Map<pc_label, string[]>`
3. **list_peers cross-PC**: agora retorna locais + remotos, todos com prefixo, deixando explícito quem mora onde
4. **Forward**: relay aceita envelope com `to_pc: pc_pubkey` (autenticação implícita: ambos Pis na mesma mesh_versions) e entrega pra WS do Pi-B

Nenhuma mudança no schema do envelope. Nenhuma mudança no protocolo agent-network entre peers locais. Só mais um "tipo de transport" sob a mesma abstração.

---

## Identificação cross-PC + injeção UDS

Duas decisões que afetam toda a arquitetura: **como o destino sabe quem enviou** (pra poder responder) e **como o envelope vindo do relay entra no broker local**.

### Reescrita de `from` no sender

Hoje o broker força `env.from = conn.name` ao receber via UDS (defesa anti-spoof entre peers locais). Pra cross-PC, o **broker_remote do sender** prefixa o `from` com o próprio `pc_label` antes de empacotar pro relay:

```
Sessão escreve no UDS:        {from:"sess-3", to:"trab:agent-1", ...}
Broker_A força from:          {from:"sess-3", to:"trab:agent-1", ...}   (idempotente)
broker_remote_A reescreve:    {from:"casa:sess-3", to:"trab:agent-1", ...}
Wrapper do relay:             {type:"pi_envelope", to_pc:"K_B", envelope:{...}}
```

### Wrapper do relay carrega identidade técnica

Pi-A se autentica no relay via WS com Pi-pubkey-A. Quando manda `pi_envelope`, o relay anexa `from_pc: <pubkey-a>` no `pi_envelope_in` entregue a Pi-B:

```
Relay → Pi-B:  {type:"pi_envelope_in", from_pc:"K_A", envelope:{from:"casa:sess-3", to:"trab:agent-1", ...}}
```

O `from_pc` é **ground truth técnico** (pubkey verificada pelo relay). O `envelope.from` é **address legível** que vai pro destino. Ambos coexistem no wire mas só `envelope` é injetado no broker.

### Anti-spoof na recepção

broker_remote_B confere: `envelope.from` começa com o prefixo `<pc_label>:` correspondente a `from_pc`? Resolve via cache de siblings (`K_A → "casa"`). Se não bater (sender mentiu sobre seu próprio prefix), drop + log. Defesa contra Pi malicioso ou compromised que tente se passar por outro PC do mesh.

### Strip de prefixo + injeção privilegiada

Antes de injetar no broker local, broker_remote_B remove o prefixo do `to` (sessão local não precisa saber seu próprio `pc_label`):

```
Recebido:        {from:"casa:sess-3", to:"trab:agent-1", ...}
Injetado:        {from:"casa:sess-3", to:"agent-1",      ...}
```

Injeção via `Broker.injectFromRemote(env)` — método novo que **pula** a regra `force from = conn.name`. Justificativa: essa regra é defesa anti-spoof entre peers UDS locais (que poderiam mentir sobre `from`); cross-PC tem sua própria defesa via `from_pc` do wrapper.

### Reply é trivial

`agent-1` em PC-B quer responder:

```
{from:"agent-1", to:"casa:sess-3", id:"r1", re:"u1", ...}
```

Broker_B vê prefixo `casa:` → handoff broker_remote_B → reescreve `from:"trab:agent-1"` → relay → broker_remote_A → injeta → `sess-3` recebe. Sem lógica nova — o prefixo que veio no `from` original do A já é o address de resposta correto.

### Audit

`audit.jsonl` marca envelopes cross-PC com campo extra `via:"relay"`. Local continua sem essa marca. Permite distinguir caminho em debug.

---

## ACK protocol — `send` com sinal de entrega

Evolução do protocolo agent-network (plano/19) que **beneficia UDS local também**, não só cross-PC. Sem ela, sender só sabe "broker aceitou", não "peer está disponível pra processar". Implementamos aqui porque o broker_remote (Wave B) precisa reportar status corretamente desde o início — adicionar depois seria retrabalho.

### Motivação

Tools hoje:
- `agent_send` — fire-and-forget. Retorna `{ok:true}` quando o broker enfileirou. Sender não sabe se peer recebeu, processou ou está vivo
- `agent_request` — send + wait reply (correlation por `re`). Bloqueia o turn do LLM até o peer responder ou timeout

Problemas:
- Duplicação confusa pro LLM (qual usar?)
- Sem sinal de "estou ocupado" — coordenação cooperativa impossível
- `request` ocupa o turn do LLM **esperando** — caro e bloqueante

### Modelo proposto

**Uma única tool `agent_send`** que aguarda um **ACK rápido** (não a resposta de conteúdo) e retorna o status:

| Status | Significado | Quando |
|---|---|---|
| `received` | Peer está livre e vai processar a mensagem em breve | Wrapper TS detecta sessão idle, marca turn_in_progress, enfileira pro LLM |
| `busy` | Peer está em meio a um turn — mensagem **descartada** | Wrapper detecta turn_in_progress=true |
| `denied` | Peer recusou a mensagem | Hoje gancho só (sem código real); futuro: blacklist via `~/.pi/remote/blacklist.json` |

ACK é gerado pelo **wrapper TypeScript do Pi**, não pelo LLM. Não custa token, não exige turn. Tempo de resposta: microssegundos local, ms cross-PC.

### Reply de conteúdo é assíncrona e usa o mesmo `send`

Quando peer eventualmente processa a mensagem (no seu próprio turn natural), responde com **outro `send`** marcando `re:<id-original>`. Sender vê a reply na inbox no próximo turn dele. Sem `agent_wait`, sem `agent_request`.

```
A.send({to:"B", body:"X?", id:"u1"}) → wait ACK (5s)
                                     → received {via UDS ou relay}
A continua seu turn imediatamente

(turn natural de B, eventualmente)
LLM_B vê u1 na inbox → processa → B.send({to:"A", body:"42", re:"u1"})

(próximo turn de A)
LLM_A vê reply na inbox com re:u1 → correlaciona com seu envio
```

Se B nunca responder, A simplesmente nunca vê reply. Sem timeout artificial — skill orienta "se a resposta não veio em N turns, considera perdida".

### Invariantes do wrapper

1. **Mutex de turn**: `busy=true` no início do turn (LLM pensando OU tool em execução); `busy=false` quando turn termina
2. **Atomicidade**: check-and-mark é atômico. Duas mensagens simultâneas em sessão idle → primeira ganha `received`, segunda ganha `busy`
3. **Drop em busy**: mensagem descartada (não enfileirada). Sender é dono do retry
4. **Received = compromisso**: wrapper só responde received se vai entregar pro LLM no próximo ciclo
5. **ACK timeout = 5s default**. Wrapper responde em ms; 5s é folga absoluta. Cross-PC pode bumpar pra 10s se a latência do relay justificar (parametrizável)

### Política de retry (skill agent-network)

Sender LLM aprende via skill:

| Status recebido | Ação recomendada |
|---|---|
| `received` | Continua. Reply (se vier) aparecerá em turn futuro |
| `busy` | Retry 2x com backoff (2s, 5s). Se ainda busy → abandona ou notifica humano |
| `denied` | Abandona imediatamente. Logar pro humano |
| `transport_error: offline` (cross-PC) | Peer não está conectado. Não retry imediato — irmão pode voltar; tentar daqui a 1min ou desistir |
| `transport_error: not_authorized` (cross-PC) | Configuração quebrada. Abandona |
| Timeout sem ACK | Tratado como transport_error generic. Investigar |

Retries são responsabilidade do **LLM via skill**, não do broker. Mantém broker burro e previsível.

### Implicação cross-PC (afeta Wave A)

`pi_envelope_error` que eu havia desenhado na Wave A vira **subset** do ACK:

- Relay-level (transporte): `transport_error: offline | not_authorized | bad_envelope`
- Peer-level (wrapper Pi-B): `received | busy | denied`

Wrapper de Pi-B gera o ACK envelope (`{body:{type:"ack", status:"received"}}`) que viaja de volta via relay pra Pi-A. Mesma máquina de status, mesma tool.

### Compatibilidade

- `agent_request` fica deprecated. Sugarred wrapper sobre `send` durante um ciclo — emite warning no log. Remover em plan futuro
- Agents que faziam `request` precisam migrar pra padrão event-driven (send + observe inbox). Skill atualizada cobre isso
- Wire backward-compat: peer antigo sem ACK responder → sender vê timeout de 5s → trata como `transport_error: no_ack`

---

## Decisões fixadas neste plano

| Decisão | Valor |
|---|---|
| Transporte cross-PC | **Relay forward** (WS já existente). PC-to-PC direto fica pra futuro |
| Naming global | `<pc_label>:<peer_name>`. `pc_label` vem do nickname do Pi (atribuído pelo Owner no pareamento). Colisão de nicknames já é prevenida no app |
| Endereço técnico de PC | Pi-pubkey (Ed25519). `pc_label` é UX; relay roteia por pubkey |
| Autorização do forward | Relay consulta `mesh_versions` do Owner. Pi-A pode enviar pra Pi-B sse ambos estão na mesma lista assinada. 403 se não |
| Quem inicia o pareamento Pi-A↔Pi-B | **Ninguém explicitamente.** A "conexão" é virtual: relay roteia pacotes baseado em mesh_versions + estado online dos WS. Não há handshake adicional entre Pis |
| Inventário (sync) | Push via relay quando broker local muda (`peer_joined`/`peer_left`) + pull lazy ao consultar `list_peers` cross-PC. Sem polling fixo |
| Cache TTL no inventário remoto | **5min** (defensivo). Push proativo elimina staleness na prática |
| Erro "PC remoto offline" | Envelope com `to` remoto e PC-B offline → broker local devolve **system error** pro sender (envelope com `body.type="route_error"`) |
| Plaintext cross-PC | Relay vê envelopes em claro (mesmo trade-off social do plan/24). Cifragem opaca fica pra plan futuro |
| Compatibilidade | Envelopes locais (`to` sem prefixo) continuam funcionando inalterados. Prefixar é opt-in pra cross-PC |

---

## Estrutura esperada

```
remote_pi/
├── relay/
│   ├── src/
│   │   ├── handlers/
│   │   │   └── pi_forward.rs                   ← novo: handler de envelope forward Pi↔Pi
│   │   ├── peers/registry.rs                   ← expor lookup "WS por Pi-pubkey"
│   │   └── mesh/verify.rs                      ← reusar pra checar same-Owner
│   └── tests/pi_forward_test.rs
│
├── pi-extension/
│   ├── src/
│   │   ├── session/
│   │   │   ├── broker.ts                       ← _resolveTargets entende prefixo "<pc>:"
│   │   │   ├── broker_remote.ts                ← novo: cache remotePeers + push notify
│   │   │   └── envelope.ts                     ← inalterado
│   │   ├── transport/
│   │   │   └── pi_forward_client.ts            ← novo: send_envelope_to_pi(pubkey, env)
│   │   ├── mesh/
│   │   │   └── siblings.ts                     ← já planejado; cache de Pis-irmãos
│   │   └── index.ts                            ← wire broker_remote ao boot
│   └── src/extension.test.ts
│
├── app/
│   ├── lib/
│   │   ├── data/
│   │   │   └── mesh/                           ← já tem; sem mudança
│   │   └── ui/
│   │       └── chat/                           ← futuro: agregação cross-PC opcional (Wave E)
│   └── test/
│
└── plan/
    └── 25-pc-mesh-bootstrap.md                 ← este arquivo
```

---

## Wave 0 — ACK protocol no broker UDS local

**Escopo**: implementar a máquina ACK no **broker local + wrapper Pi + tools** antes de tocar em cross-PC. Validar o modelo event-driven em ambiente simples. Cross-PC (Waves seguintes) já nasce com ACK funcional.

### Passos

1. **Wrapper Pi rastreia `turn_in_progress`**:
   - `pi.on("turn_start")` → marca true (incluindo tools em execução)
   - `pi.on("turn_end")` → marca false
   - Investigar se `@mariozechner/pi-coding-agent` expõe esses hooks; se não, instrumentar via SessionManager
2. **Broker.injectEnvelope** (entrega pro peer UDS) ganha **ACK auto-reply**:
   - Antes de write no socket do peer destino, dispara síncrono: peer está busy? → responde ACK busy ao sender, drop envelope
   - Idle → marca peer busy, write no socket (entrega o envelope), responde ACK received ao sender
   - Atomicidade via lock simples (Node single-thread ajuda, mas se houver async no caminho usar mutex explícito)
3. **`agent_send` tool**: passa a aguardar ACK (Promise resolvida quando ACK envelope chega via `re:<send-id>`). Timeout 5s. Retorna `{status: "received"|"busy"|"denied"|"timeout"}`
4. **Deprecation de `agent_request`**: stub que internamente faz `send + observa inbox por re`. Log warning. Documenta migração na skill
5. **Skill agent-network**: atualizada com:
   - Padrão event-driven (send retorna status, reply vem assíncrona)
   - Matriz de retry por status (received/busy/denied)
   - Como observar inbox por reply (em turn futuro)

### Critério de aceite

- `agent_send` retorna `received` em <100ms quando peer idle
- 2º `agent_send` durante turn do peer retorna `busy`
- Reply via outro `send` com `re` chega no sender em turn subsequente
- `agent_request` continua funcionando mas emite warning
- `pnpm test` cobre matriz received/busy + reply assíncrona

---

## Wave A — Relay: handler de envelope forward Pi↔Pi

**Escopo**: relay aceita um novo tipo de mensagem WS de um Pi pedindo "encaminhe este envelope pro Pi com pubkey X". Verifica via mesh_versions que ambos são do mesmo Owner. Encaminha pro WS do destinatário.

### Protocolo (esboço)

Cliente WS (Pi-A) → Relay:
```json
{
  "type": "pi_envelope",
  "to_pc": "<pi-b-pubkey-base64>",
  "envelope": { "from": "casa:sess-3", "to": "trab:agent-1", "id": "...", "re": null, "body": {...} }
}
```

Relay → Pi-B (via WS):
```json
{
  "type": "pi_envelope_in",
  "from_pc": "<pi-a-pubkey-base64>",
  "envelope": { ... }  // verbatim
}
```

**ACK do wrapper de Pi-B** (gerado pela máquina da Wave 0, viaja de volta pelo mesmo caminho):
```json
// Pi-B → relay → Pi-A
{
  "type": "pi_envelope",
  "to_pc": "<pi-a-pubkey-base64>",
  "envelope": { "from": "trab:_wrapper", "to": "casa:sess-3", "id": "<new>", "re": "<id-original>",
                "body": { "type": "ack", "status": "received" } }
}
```

**Transport errors** (relay nem chegou no Pi-B) — gerados pelo relay direto:
- `transport_error: offline` (no WS pro to_pc)
- `transport_error: not_authorized` (não mesh-irmão)
- `transport_error: bad_envelope` (envelope inválido)

Formato:
```json
// Relay → Pi-A
{
  "type": "pi_envelope_in",
  "from_pc": "<relay>",
  "envelope": { "from": "_relay", "to": "casa:sess-3", "id": "<new>", "re": "<id-original>",
                "body": { "type": "transport_error", "reason": "offline" } }
}
```

Vantagem: tudo chega como envelope normal com `re:<send-id>`. O `agent_send` tool no Pi-A já sabe correlacionar (mesma máquina da Wave 0).

### Decisões

- **Owner-pubkey implícita**: pode vir tanto de cache local (relay sabe o Owner do Pi via pair flow inicial) quanto via consulta a mesh_versions. Decidir: começa via mesh_versions (mais simples, sem novo estado em memória). Otimização vem depois.
- **Sem queue offline**: se Pi-B está offline, falha imediatamente (route_error). Pi-A decide se faz retry ou marca como falha pro usuário. Relay não armazena.
- **Sem broadcast cross-PC nesta rodada**: `to_pc` é unicast por Pi-pubkey. Multicast (envelope pra todos os Pis-irmãos) fica como evolução.

### Passos

1. **Adicionar `pi_envelope` ao protocolo WS** existente (Pi↔Relay). Reusar codec atual
2. **Handler `pi_forward.rs`**: parse + verify mesh membership + lookup WS de Pi-B + forward
3. **Verify via mesh_versions**: helper que carrega blob mais recente do Owner do Pi-A e checa se to_pc está na lista. Cache em memória (TTL 60s) pra evitar hit em SQLite por mensagem
4. **Testes integração**:
   - happy path: Pi-A → Pi-B com ambos online + same-Owner → entrega
   - Pi-B offline → route_error
   - Pi-A e Pi-B em Owners diferentes → 403
   - Envelope malformado → 400

### Critério de aceite

- Endpoint funcional via teste de integração em `relay/tests/`
- `cargo test` passa
- Latência adicional ≤ 50ms p99 em loopback

---

## Wave B — Pi-extension: broker_remote (cache + push)

**Escopo**: novo módulo `broker_remote.ts` que mantém o cache `Map<pc_label, string[]>` de peers conhecidos em outros PCs, alimentado por push proativo via relay e por pull lazy quando alguém pergunta `list_peers`.

### Sub-componentes

1. **Cache**: `RemotePeers` com TTL 5min por entry. Refresh manual ao receber `pi_envelope_in` com `body.type="peers_update"`
2. **Publisher local**: quando o broker local emite `peer_joined`/`peer_left`, `broker_remote` envia um envelope `{body: {type:"peers_update", peers: [...current]}}` pra **todos** os Pis-irmãos (via Wave A — um forward por irmão). Esse envelope NÃO entra no broker UDS do destino — é interceptado pelo `broker_remote` lá
3. **Subscriber**: ao receber `peers_update` de um Pi-X, atualiza cache `remotePeers["<pc_label>"]`
4. **Bootstrap**: no boot, após `siblings.ts` listar Pis-irmãos, envia `{body: {type:"peers_request"}}` pra cada um. Cada um responde com `peers_update`
5. **PC label**: vem do manifest publicado (plan/24 evolução: ou simplesmente do nickname). Cada Pi precisa saber seu próprio `pc_label`

### Passos

1. Implementar `broker_remote.ts` com a API:
   - `getRemotePeers(pcLabel): string[]`
   - `getAllRemote(): Record<pcLabel, string[]>`
   - `onLocalPeersChanged(peers: string[])` — chamado pelo broker
   - `handleIncomingPiEnvelope(env)` — interceptador de envelopes de controle (`peers_update`, `peers_request`, `route_error`)
2. Wire no `index.ts`: instanciar após broker local + após siblings carregadas
3. Hook no broker local: emit changes quando peer entra/sai
4. Tests com mock de `pi_forward_client`

### Critério de aceite

- Boot do Pi-B com Pi-A online → Pi-B tem `remotePeers[<a>]` populado em ≤500ms
- `peer_joined` em Pi-A → Pi-B vê atualização em ≤1s sem polling
- Pi-A vai offline → Pi-B mantém entry no cache (TTL 5min), mas envelope pra ele resultará em `route_error`
- `pnpm test` cobre cache TTL + push + interceptação de envelopes de controle

---

## Wave C — Broker: roteamento por prefixo `<pc>:`

**Escopo**: estender `Broker._resolveTargets` pra entender prefixo. Adicionar caminho de envio cross-PC via `pi_forward_client`.

### Passos

1. **Parser de address**: helper `parseAddress(to: string) → {pcLabel, peerName} | null` (null se sem prefixo = local)
2. **Em `_route`**:
   - Sem prefixo OU prefixo == self → caminho atual (UDS)
   - Prefixo != self → busca em `remotePeers`:
     - Se peer existe → `pi_forward_client.send(pcPubkey, env)`
     - Se peer não existe (cache miss) → tentar refresh via `peers_request` síncrono com timeout 2s; falha → `route_error`
3. **Resposta de erro do relay**: `pi_envelope_error` chega pelo WS → broker_remote injeta `route_error` envelope no broker local (entregue ao `env.from` original)
4. **list_peers estendido**: quando alguém envia `{to: "broker", body: {type:"list_peers"}}`, broker retorna locais + remotos prefixados (ex.: `["sess-1", "sess-2", "casa:sess-3", "casa:agent-1"]`)
5. **Backward-compat**: peer local com nome contendo `:` continua funcionando se não houver `pc_label` com esse nome (parser confere antes)

### Critério de aceite

- Envelope local (`to: "agent-1"`) roteado via UDS — sem regressão
- Envelope cross-PC (`to: "casa:sess-3"`) roteado via relay → broker remoto → UDS final
- `list_peers` retorna inventário agregado
- `pnpm test` cobre matriz: local/remote × happy/offline/malformed

---

## Wave D — Naming, lifecycle, observabilidade

**Escopo**: refinar o que aparece pro usuário e pro dev.

### Passos

1. **PC label resolution**:
   - Pi conhece seu nickname (vem do pareamento, persistido em `~/.pi/remote/identity.json`)
   - Slash command `/remote-pi config` mostra `pc_label` em uso
   - Conflito (mesmo nickname em 2 Pis) já bloqueado no app no pareamento; defensivo aqui também (warning no boot)
2. **CLI**: `pi remote peers` (ou estendido `pi remote status`) lista locais + remotos com agrupamento
3. **audit.jsonl estendido**: envelopes cross-PC recebem campo extra `via: "relay"` no log; UDS continua sem essa marca
4. **Métricas (opcional MVP)**: contadores de forward enviados/recebidos/erro

### Critério de aceite

- `pi remote peers` mostra grupos `local:` e `remote:<pc_label>:` claros
- Audit log distingue UDS vs relay
- Tests cobrem parser de address + collision defense

---

## Wave E — App (mínimas mudanças)

**Escopo**: o app continua falando com cada Pi pareado individualmente como hoje. Esta wave **não exige nada** do app pra que cross-PC routing funcione entre Pis (uso típico: agentes em PCs diferentes colaborando).

**Opcional**: se o app quiser agregar sessões cross-PC numa única view, pode emitir `list_peers` cross-PC via qualquer Pi conectado. Mas isso fica pra plan/26 (sessões como entidades visíveis no app).

### Passos

- Nenhum mandatório nesta rodada
- (Opcional) Logar: cliente da extensão pode opcionalmente exibir badge "sessão remota em PC-X" se quiser; não é UX core ainda

### Critério de aceite

- App continua funcionando inalterado (nenhuma regressão)

---

## Definition of Done

### Wave 0 — ACK protocol (local)
- [ ] Wrapper Pi rastreia `turn_in_progress` via hooks do SDK
- [ ] Broker entrega com ACK auto-reply (received/busy)
- [ ] `agent_send` aguarda ACK com timeout 5s
- [ ] `agent_request` deprecated com warning
- [ ] Skill agent-network atualizada (matriz de retry + padrão event-driven)
- [ ] `pnpm test` cobre received/busy/timeout + reply assíncrona

### Wave A — Relay forward
- [ ] `pi_envelope` adicionado ao protocolo WS
- [ ] Handler com verify via mesh_versions
- [ ] 4 testes de integração (happy/offline/cross-Owner/malformed)
- [ ] `cargo test` passa

### Wave B — broker_remote
- [ ] Cache + TTL implementados
- [ ] Push proativo em `peer_joined`/`peer_left` local
- [ ] Interceptação de envelopes de controle
- [ ] `pnpm test` cobre cenários

### Wave C — Broker prefix routing
- [ ] `_route` entende `<pc>:` prefix
- [ ] Caminhos local/remoto convivem
- [ ] `list_peers` agregado
- [ ] Backward-compat verificada

### Wave D — Naming + observabilidade
- [ ] `pc_label` derivado de nickname e exposto
- [ ] `pi remote peers` lista cross-PC
- [ ] audit.jsonl marca via

### Wave E — App
- [ ] Nenhuma regressão (smoke test)

### Roundtrip end-to-end
- [ ] PC-A e PC-B do mesmo Owner, ambos online
- [ ] Sessão `agent-1` em PC-A; sessão `agent-1` em PC-B (mesmo nome local, OK pois prefixos diferem)
- [ ] Agente em PC-A envia `{to: "<pc-b-label>:agent-1", body: {...}}` → agente em PC-B recebe e responde
- [ ] Pi-B desliga → PC-A recebe `route_error` no próximo envio
- [ ] Pi-B volta → cache atualiza via push em ≤1s

---

## Trade-offs explícitos

- **Sem PC-to-PC direto.** Relay continua sendo o broker físico. Latência cross-PC ≈ 2× RTT até relay. Aceitável até a demanda exigir P2P real
- **Sem queue offline.** Pi-A envelope pra Pi-B offline → falha imediata. Owner-app tem que tratar UX de "PC indisponível"
- **Plaintext no relay.** Mesmo trade-off social do plan/24. Cifragem cross-PC fica pra plan futuro
- **Naming via nickname.** Se Owner renomear PC, addresses ficam stale temporariamente. LWW do plan/24 + push proativo mitigam, mas race teórica existe
- **Mesh autorização via mesh_versions.** Relay precisa consultar pra cada forward (com cache 60s). Custo aceitável pra escala de uso individual; revisitar se virar serviço público em escala
- **5 waves, escopo médio.** Wave A + B + C são o coração (~80% do trabalho). D e E são polimento

---

## Não-objetivos

- **App agregando sessões cross-PC.** Fica pra plan/26
- **PC-to-PC direto.** Fica pra plan/27
- **Multicast cross-PC.** Broadcast cross-PC seria útil mas não bloqueia. Plan futuro
- **Queue de mensagens offline.** Relay não vira mail server. Aceito
- **Roteamento por capability/role.** Apenas roteamento por nome (com prefixo). Mais sofisticado fica fora
- **Cifragem opaca cross-PC.** Plan futuro

---

## Próximos planos

- **`plan/26-sessions-cross-pc-app.md`** — app agrega sessões cross-PC numa única view. Reusa `list_peers` cross-PC + manifest pra UX "todas as suas sessões em todos os seus PCs"
- **`plan/27-pc-to-pc-transport.md`** — substituir relay por WebRTC/QUIC quando NAT permite. Relay vira fallback. broker_remote ganha "transport plugin"
- **`plan/28-pc-mesh-encryption.md`** — cifrar envelopes cross-PC com chave derivada da Owner-sk. Relay para de ver conteúdo (continua roteando por to_pc)
