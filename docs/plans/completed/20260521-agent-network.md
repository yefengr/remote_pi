> **历史归档。** 原始路径：`plan/19-agent-network.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 19 — Agent Network (sessão local via UDS + reestruturação dos comandos `/remote-pi`)

> **Status**: PROPOSTA — não executar antes do MVP atual estar shippado e validado.
> **Pré-requisito**: ler [`20260521-agent-network-rfc.md`](20260521-agent-network-rfc.md)
> para motivação, contexto e decisões abertas.
> **Artefato**: skill em [`../../reference/history/20260521-agent-network-skill.md`](../../reference/history/20260521-agent-network-skill.md)
> será extraído pra `pi-extension/skills/agent-network.md` durante implementação.
>
> **Renumerado 2026-05-21** (era plano 17 — colidia com `20260521-rooms.md` executado).
>
> **Restrições do usuário (2026-05-21)** — relevantes pra escopo deste plano:
> - **(a)** README/docs atualizados só ao final — não bloqueia execução
> - **(b)** **Sem migração de storage**: **Passo 1 abaixo CAI**. Mantém `~/.pi/remote/`; broker/sessions vivem em `~/.pi/remote/sessions/<name>/` (subdir novo dentro do path existente)
> - **(c)** Relay features (pairing/presence/rooms/etc do plano 17) ficam **intactas**. Este plano só **adiciona** camada agent-network local + **refatora nomes** dos comandos `/remote-pi`

---

## Objetivo

Adicionar à pi-extension um segundo eixo: **rede local de agentes** via Unix
Domain Socket. Reestruturar os comandos `/remote-pi` em torno do conceito de
**sessão** (local) com **relay** (mobile) como capacidade opcional.

Resultado esperado ao final:

- Múltiplos Pi processes na mesma máquina conversam via UDS em sessão compartilhada
- Comandos `/remote-pi` reorganizados: `join` / `leave` / `rename` para sessão;
  `relay start/stop` / `relay url` para mobile; `pair` / `devices` / `revoke`
  para pareamento (mantém)
- Footer do Pi mostra estado da sessão + relay sempre visível
- Migração one-shot do storage `~/.pi/remote/` → `~/.pi/remote-pi/`
- Aliases temporários dos comandos antigos durante 1 release

**Este plano NÃO altera o protocolo de relay (mobile)**. Aquele continua como
está. Adiciona um transporte paralelo (UDS) e refatora a CLI.

---

## Decisões fixadas (do RFC + `../../adr/20260518-closed-decisions.md`)

| Decisão | Valor |
|---|---|
| Transporte local | Unix Domain Socket (`broker.sock` per sessão) |
| Líder | Auto-elect via bind race; promoção transparente em failover |
| Identidade do agente | Nome humano (default: basename do cwd) + auto-suffix `#N` em colisão |
| Protocolo | 5 campos: `from`, `to`, `id`, `re`, `body` |
| Filtragem | **Broker filtra**; agentes só recebem o que é endereçado a eles |
| Toggle `relay` | SIM |
| Toggle `join` | NÃO (explícito por segurança) |
| Default name | `basename(cwd)` |
| Relay URL | Global (per-instalação) |
| Sessão sem relay | Caso válido (agent-network puro) |
| Pareamento mobile | 1 sessão = 1 pareamento (decisão A original mantida) |
| Persistência de fila | Não (kernel buffer); audit em `audit.jsonl` paralelo |

---

## Estrutura final esperada

```
remote_pi/
├── pi-extension/
│   ├── src/
│   │   ├── index.ts                       ← refatorado, comandos novos
│   │   ├── session/                       ← novo
│   │   │   ├── broker.ts                  ← UDS server + roteamento
│   │   │   ├── peer.ts                    ← SessionPeer (cliente OU líder)
│   │   │   ├── leader_election.ts         ← bind race, retry, failover
│   │   │   ├── envelope.ts                ← serialize/parse dos 5 campos
│   │   │   ├── local_config.ts            ← <cwd>/.pi/remote-pi/config.json
│   │   │   ├── global_config.ts           ← ~/.pi/remote-pi/sessions/
│   │   │   ├── wizard.ts                  ← join wizard interativo
│   │   │   └── *.test.ts
│   │   ├── ui/
│   │   │   └── footer.ts                  ← updateFooter() com setStatus/setTitle
│   │   ├── pairing/                       ← (existe — mantém)
│   │   ├── protocol/                      ← (existe — mantém, separado do envelope local)
│   │   ├── transport/
│   │   │   ├── relay_client.ts            ← (existe — mantém)
│   │   │   └── peer_channel.ts            ← (existe — mantém)
│   │   ├── migrate.ts                     ← novo: migração ~/.pi/remote → ~/.pi/remote-pi
│   │   └── settings.ts                    ← extendido pra apontar pra ~/.pi/remote-pi
│   └── skills/
│       └── agent-network.md               ← copiado de plan/17-agent-network-skill.md
```

```
~/.pi/remote/                               ← path EXISTENTE, sem migração (decisão b)
├── settings.json                           ← relay_url (já existe)
├── identity.json                           ← Ed25519 keypair (já existe)
├── peers.json                              ← celulares pareados (já existe — não move)
├── skills/                                 ← NOVO
│   └── agent-network.md                   ← extraída pra cá no install
└── sessions/                               ← NOVO subdir
    └── <session-name>/
        ├── broker.sock                     ← UDS endpoint
        ├── session.json                    ← metadata (created_at, owner)
        └── audit.jsonl                     ← log append-only
```

```
<cwd>/.pi/remote-pi/
└── config.json                             ← {agent_name, session_name} (NOVO; só por cwd)
```

> Nota: `peers.json` (mobile pairings) continua **global** em `~/.pi/remote/peers.json`,
> não migra pra `sessions/<name>/peers.json` como previsto originalmente.
> Pareamento mobile continua escopado ao Mac inteiro (decisão c — features de relay
> intactas).

---

## Passos

### ~~Passo 1 — Storage layout + migração~~ **CANCELADO** (decisão b, 2026-05-21)

> Manter `~/.pi/remote/` como hoje. Criar **apenas** os subdirs novos:
> `~/.pi/remote/sessions/` (para broker per-sessão) e `~/.pi/remote/skills/`
> (para a skill agent-network deployada). Não move nem renomeia nada existente.
>
> Implementação reduzida: `pi-extension/src/session/global_config.ts` faz
> `mkdirSync('~/.pi/remote/sessions', { recursive: true })` no init e segue.
> Sem `migrate.ts`, sem backup, sem renomeação.

### Passo 2 — Envelope + serialização

**Localização**: `pi-extension/src/session/envelope.ts`

**Função**: parse/serialize do envelope de 5 campos. Validação básica.

```typescript
export type Envelope = {
  from: string;
  to: string | string[];   // "broadcast" também aceito
  id: string;              // uuidv7
  re: string | null;
  body: unknown;
};

export function serialize(env: Envelope): string {
  return JSON.stringify(env) + "\n";  // line-delimited
}

export function parse(line: string): Envelope { ... }
```

**Validações**:
- `from` e `to` são strings não-vazias (ou array de strings em multicast)
- `id` é UUID v7
- `re` é null ou UUID v7
- `body` é qualquer JSON serializable

**Critério de aceite**:
- [ ] Testes roundtrip pra cada tipo de mensagem (task, reply, broadcast)
- [ ] Validação rejeita envelopes malformados
- [ ] UUID v7 ordenável (gerar 3 IDs em sequência, ordem temporal preserved)

### Passo 3 — Leader election (auto-elect via bind race)

**Localização**: `pi-extension/src/session/leader_election.ts`

**Função**: tenta `connect()` primeiro; se falhar, tenta `bind()`. Se outro
processo ganhou a corrida (EADDRINUSE), volta a tentar `connect()` com backoff.

```typescript
export async function joinOrLead(sockPath: string): Promise<"leader" | "follower"> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const conn = await tryConnect(sockPath);
    if (conn) return "follower";

    const server = await tryBind(sockPath);
    if (server) return "leader";

    await sleep(50 + Math.random() * 100);
  }
  throw new Error("election failed");
}
```

**Tratamento de stale sock**: na falha de `connect()` com ECONNREFUSED + arquivo
existe, removê-lo (com lstat checando que é socket type) antes de tentar bind.

**Critério de aceite**:
- [ ] Teste: 3 processos lançados simultaneamente, exatamente 1 ganha leader
- [ ] Teste: leader mata, 2 followers detectam, 1 vira novo leader
- [ ] Teste: stale .sock file não-orfão é removido limpo
- [ ] Teste: race window double-bind nunca permite 2 leaders simultâneos

### Passo 4 — Broker (roteamento + filtragem)

**Localização**: `pi-extension/src/session/broker.ts`

**Função**: quando um Pi é líder, hospeda broker. Aceita conexões, mantém
mapa `name → Connection`, roteia mensagens conforme campo `to`.

Routing:
- `to: "<name>"` → entrega pra conexão daquele nome (se múltiplos, pro canonical primeiro registrado)
- `to: "<name>#N"` → entrega pra peer específico
- `to: ["a", "b"]` → multicast pros listados
- `to: "broadcast"` → fanout pra todos menos sender
- Mensagem cujo `to` não bate com nenhum peer registrado: descarta + log warn

**Auto-suffix de nome em colisão**: register com nome já tomado retorna ack com
`name_assigned: "<name>#2"`. Cliente passa a usar esse nome.

**Audit log**: cada mensagem roteada é appendada em `audit.jsonl` síncronamente
antes de entregar.

**Critério de aceite**:
- [ ] Teste: 3 peers registrados, msg pra peer:1 NÃO chega em peer:2/peer:3
- [ ] Teste: broadcast chega em todos exceto sender
- [ ] Teste: auto-suffix em colisão funciona (3 backends → backend, backend#2, backend#3)
- [ ] Teste: msg pra nome inexistente é descartada sem crash
- [ ] Teste: audit.jsonl reflete todas as mensagens em ordem

### Passo 5 — SessionPeer (API simétrica)

**Localização**: `pi-extension/src/session/peer.ts`

**Função**: classe que esconde se você é líder ou cliente. Mesma API
(`send`, `request`, `onMessage`) funciona em ambos.

```typescript
export class SessionPeer {
  async start(sockPath: string, name: string): Promise<void>
  async send(to: string | string[], body: unknown): Promise<void>
  async request(to: string, body: unknown, timeoutMs?: number): Promise<Envelope>
  onMessage(handler: (msg: Envelope) => void): void
  async rename(newName: string): Promise<string>
  async leave(): Promise<void>
}
```

**Failover transparente**: quando follower detecta close do socket de saída,
roda `joinOrLead()` novamente. Outros peers detectam o leader morto via close
e fazem o mesmo. Um vira novo líder; restantes reconnectam como clients.

**Pending map**: `Map<id, callback>` pra demuxar respostas de `request()`s
paralelos. `Promise.all([request, request, ...])` espera todas.

**Critério de aceite**:
- [ ] Teste: API idêntica em código de líder e cliente
- [ ] Teste: `Promise.all([request(a), request(b), request(c)])` retorna 3 respostas
- [ ] Teste: timeout individual em `request()` rejeita Promise sem afetar outras
- [ ] Teste: failover — líder mata, follower assume, outro follower reconnecta, msgs continuam fluindo em ~500ms
- [ ] Teste: rename atualiza no broker e propaga via `peer_renamed` system event

### Passo 6 — Wizard de `/remote-pi join` interativo

**Localização**: `pi-extension/src/session/wizard.ts`

**Função**: quando `/remote-pi join` é invocado sem argumentos, mostrar
selector com sessões existentes + opção "Criar nova".

Usar `ctx.ui.select(title, options, opts)` (já disponível na API Pi).

```
[remote-pi] Sessões disponíveis:
  1. backoffice    (2 peers: orchestrator, backend)
  2. remote_pi     (1 peer: orchestrator)
  3. ━━━ Criar nova sessão ━━━
> _
```

Se "Criar nova" → prompt pro nome via `ctx.ui.input("Nome da sessão", "...")`.

**Primeira execução** (sem `.pi/remote-pi/config.json` local): wizard estendido
pergunta também o nome do agente (default: `basename(cwd)`).

**Critério de aceite**:
- [ ] `/remote-pi join` sem argumentos mostra wizard
- [ ] Wizard lista todas sessões em `~/.pi/remote-pi/sessions/`
- [ ] Selecionar sessão existente → conecta + atualiza config local
- [ ] "Criar nova" → prompt de nome + cria diretório + vira líder
- [ ] Primeira execução pergunta também o nome do agente

### Passo 7 — Reestruturação dos comandos `/remote-pi`

**Localização**: `pi-extension/src/index.ts`

**Função**: refatora os comandos atuais conforme a nova taxonomia. Aliases
temporários pros comandos antigos.

Novos comandos:

```
/remote-pi                       → status (não-destrutivo)
/remote-pi join                  → wizard
/remote-pi join <name>           → upsert (existe→entra, não→cria)
/remote-pi leave                 → sai da sessão
/remote-pi rename <novo-nome>    → renomeia agente
/remote-pi sessions              → lista todas em ~/.pi/remote-pi/sessions/

/remote-pi relay                 → TOGGLE start/stop
/remote-pi relay url <url>       → configura URL global
/remote-pi relay start           → start explícito
/remote-pi relay stop            → stop explícito
/remote-pi relay status          → estado da conexão

/remote-pi pair                  → QR (requer relay started)
/remote-pi devices               → lista celulares pareados na sessão atual
/remote-pi revoke <shortid>      → revoga celular
```

Aliases temporários (1 release, com warning):
- `/remote-pi start` → alias de `/remote-pi relay start` + auto-`join default`
- `/remote-pi stop` → alias de `/remote-pi leave` + `/remote-pi relay stop`
- `/remote-pi list` → alias de `/remote-pi devices`
- `/remote-pi add-relay` → alias de `/remote-pi relay url`

State machine nova:

```
idle → joined → (relay_started → (paired))
```

`joined` é o novo "started" semanticamente — em uma sessão local. `relay_started`
ativa o transporte mobile. `paired` quando celular conecta.

**Critério de aceite**:
- [ ] 13 comandos novos registrados e funcionando
- [ ] Aliases legados imprimem warning de deprecation mas funcionam
- [ ] `/remote-pi` (sem args) mostra status compreensivo
- [ ] Toggle `/remote-pi relay` alterna entre start/stop conforme estado atual

### Passo 8 — Footer visual no Pi

**Localização**: `pi-extension/src/ui/footer.ts`

**Função**: `updateFooter(ctx)` chamado em todos state transitions, atualiza
`ctx.ui.setStatus()` e `ctx.ui.setTitle()`.

```typescript
function updateFooter(ctx: ExtensionContext) {
  if (_state.session) {
    ctx.ui.setStatus("remote-pi:session", `📡 ${_state.session} (${_state.peerCount})`);
  } else {
    ctx.ui.setStatus("remote-pi:session", undefined);
  }

  if (_state.relayOn) {
    ctx.ui.setStatus("remote-pi:relay", _state.devicePaired
      ? `🟢 relay (📱 ${_state.devicePaired})`
      : "🟡 relay aguardando pareamento"
    );
  } else {
    ctx.ui.setStatus("remote-pi:relay", undefined);
  }

  const titleParts: string[] = [];
  if (_state.session) titleParts.push(_state.session);
  if (_state.relayOn) titleParts.push("relay");
  ctx.ui.setTitle(titleParts.length ? `Pi · ${titleParts.join(" · ")}` : "Pi");
}
```

Chamar em: `_cmdJoin`, `_cmdLeave`, `_cmdRelayStart`, `_cmdRelayStop`,
handlers de `peer_joined`/`peer_left`/`pair_ok` do broker.

**Critério de aceite**:
- [ ] Após join, footer mostra `📡 <nome> (N)`
- [ ] Após relay start, footer adiciona `🟢 relay`
- [ ] Após pair, mostra dispositivo `📱`
- [ ] Após leave, statuses são limpas (chamada com `undefined`)
- [ ] Terminal title reflete estado (visível na aba do Ghostty/iTerm)

### Passo 9 — Skill `agent-network.md` deployada

**Localização**: `pi-extension/skills/agent-network.md` (copiada de
`plan/17-agent-network-skill.md`)

**Função**: durante install/setup da extension, garantir que a skill é
copiada/disponível pra os agentes Pi que entrarem em sessão.

Estratégia: extension expõe `resources_discover` event handler que aponta
pra `pi-extension/skills/` como diretório de skills.

```typescript
pi.on("resources_discover", () => ({
  skillPaths: [path.join(extensionDir, "skills")],
}));
```

**Critério de aceite**:
- [ ] Skill `agent-network` aparece no autocomplete de skills do Pi
- [ ] Agente Pi em uma sessão, ao usar `/skill agent-network`, vê o conteúdo
- [ ] Skill orienta corretamente quando agente recebe msg e como responder

### Passo 10 — Testes end-to-end

**Localização**: `pi-extension/src/session/e2e.test.ts`

**Cenários**:

1. **Single agent**: 1 Pi roda `/remote-pi join solo`. Verifica que vira leader,
   broker.sock criado, status footer mostra `solo (1)`.

2. **Dois agents, dispatch simples**: orq + backend. orq.request("backend", "ping")
   retorna "pong". `audit.jsonl` registra envio + resposta.

3. **Wave paralela**: orq + 2 workers (backend, frontend). orq dispara
   `Promise.all([request(be), request(fe)])`. Ambos respondem em paralelo.
   Verificar que `re` correlaciona corretamente.

4. **Failover**: 3 agents, líder é orq. Mata orq. Backend assume liderança em
   <500ms. Frontend reconnecta. msg da skill (`leader_changed` broadcast)
   chega em todos.

5. **Pareamento mobile dentro da sessão**: orq cria sessão `myproject`, ativa
   relay, pareia celular. Celular se vê dentro da sessão (peers list inclui
   `mobile:iphone-X` opcional, ou tratado como sub-conexão do orq — decidir).

6. **Colisão de nome**: 3 Pis abrem em pastas chamadas "backend". Primeiro
   ganha `backend`, segundos viram `backend#2`, `backend#3`.

7. **Comando legado**: `/remote-pi start` ainda funciona com warning.

**Critério de aceite**:
- [ ] Todos 7 cenários passam em CI
- [ ] Latência média de `request().then(reply)` <50ms em localhost
- [ ] Sem regressão nos testes existentes do relay

---

## Definition of Done

- [x] ~~Migração `~/.pi/remote/` → `~/.pi/remote-pi/`~~ — cancelada (decisão b). Em vez disso: `mkdirSync` dos subdirs novos `sessions/` e `skills/` dentro do `~/.pi/remote/` existente
- [ ] Envelope serialize/parse + validação (passo 2)
- [ ] Leader election com 4 testes (passo 3)
- [ ] Broker com roteamento + filtragem + audit (passo 4)
- [ ] SessionPeer API simétrica + failover (passo 5)
- [ ] Wizard de `join` interativo (passo 6)
- [ ] 13 comandos novos + 4 aliases legados (passo 7)
- [ ] Footer com 3 status keys + title (passo 8)
- [ ] Skill `agent-network` deployada e descobrível (passo 9)
- [ ] 7 cenários e2e passam (passo 10)
- [ ] Decisões abertas (Q1-Q8 no RFC) registradas em `../../adr/20260518-closed-decisions.md`
- [ ] Posicionamento decidido (reposiciona, mantém, ou separa — RFC seção
      "decisão que isso força")
- [ ] Aliases legados marcados como deprecated com data de remoção
- [ ] Documentação no README atualizada
- [ ] Commit final em wave única: `agent-network: session + commands + footer`

---

## Notas de execução

1. **Use overlay `.orchestration/`** ativo. Este plano toca apenas pi-extension —
   wave única, sem coordenação com app/relay.
2. **Não tocar app nem relay neste plano**. Eles continuam intocados.
3. **Branch dedicada** (`feat/agent-network`) — escopo grande, merge só com
   green checks em todos os e2e tests.
4. **Decidir Q1-Q8 antes do passo 7** (comandos), porque o naming depende.
5. **Não criar dependência cruzada** entre session/ e pairing/. Eles vivem
   lado-a-lado, só interagem via SessionPeer events (`session_joined` →
   pairing/relay ganha contexto de qual sessão expor).

---

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Migração quebra storage de usuário | Backup automático em `~/.pi/remote.backup-<ts>/` antes de mover |
| Stale sock files acumulam | Cleanup no start (unlink se não responde a connect) |
| Race condition leader election | Testes específicos (passo 3); confirmar via "I_AM_LEADER" round-trip |
| Sessões órfãs (broker morto, file remains) | Heartbeat opcional do leader; clients detectam ausência |
| Footer poluído em terminal estreito | `setStatus` aceita undefined; limpar quando estado clear |
| Aliases legados criam confusão | Documentação + warning explícito; remover no release+1 |
| Reposicionamento confunde users existentes | Manter README inicial focado em relay, agent-network como "advanced" |

---

## Próximos planos (que dependem deste)

- **`18-agent-network-mobile`** (opcional): expor sessão local pro celular,
  permitindo que app veja outros agents na sessão. Requer protocolo extension
  pra `peers` list cross-transport.
- **`19-cli-pi-pi`** (opcional): comando shell `pi-pi <session> <agent> "<msg>"`
  pra disparar mensagens sem entrar no TUI Pi. Equivalente do `cmux-dispatch.sh`
  mas via UDS.
- **`20-multi-machine-bridge`** (opcional, futuro distante): bridge entre 2
  máquinas conectando suas sessões locais via relay. Cross-machine real.

---

## Apêndice — Como avaliar este plano

O orquestrador (Claude na raiz do remote_pi) deve, **após o MVP fechar**,
avaliar este plano nesta ordem:

1. **Ler o RFC** (`17-agent-network-rfc.md`) integralmente antes de qualquer
   outra coisa
2. **Checar "Sinais que validariam executar"** no RFC. Se nenhum bate, arquiva
3. **Decidir Q1-Q8** explicitamente em conversa com o usuário
4. **Estimar escopo**: ~3 semanas pra implementação completa, pode ser fasado
   (passo 1-5 primeiro, depois 6-10)
5. **Se aprovado**, executar com overlay `.orchestration/` ativo, dispatchando
   pra pi-extension worker via `cmux-dispatch.sh`
6. **Se rejeitado**, marcar status no header do plano como REJECTED com razão
   e data
