> **历史归档。** 原始路径：`plan/26-daemon-mode.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 26 — Daemon mode: agentes Pi rodando 24/7 com supervisor

Objetivo: permitir que o usuário **promova um Pi já configurado a daemon** (processo em background, `pi --mode rpc`) gerenciado por um **supervisor único** que roda como serviço do SO. Casos de uso: agente de edição de vídeo que fica ligado no servidor pra responder pelo celular, batch jobs disparados via cron, fleet de agentes especializados (1 por pasta/projeto).

A primeira viabilização concreta da visão "Pi sempre disponível" (ver memory `project-vision-pc-mesh`). Não substitui o uso interativo do Pi — o daemon mode é **paralelo**, complementar.

---

## Contexto e relação com planos anteriores

- **Plano 19** entregou a mesh UDS local (`SessionPeer`). Daemon mode reusa isso: cada daemon entra na mesma sessão `local`, vê os outros agentes como peers.
- **Plano 21** trouxe o wizard `/remote-pi`. Daemon mode **pula o wizard** porque o usuário já configurou o agente interativamente antes de promover a daemon.
- **Plano 24 W2D** (multi-channel) já garante que cada daemon pode receber pareamentos de N owners simultâneos sem stop/start. Daemons herdam isso automaticamente.
- **CWD lock** (UDS bind em `~/.pi/remote/locks/<roomId>.sock`) garante 1 Pi por pasta — daemon respeita o mesmo lock.

Pi tem `--mode rpc` (JSON em stdin/stdout, sem TTY) explicitamente desenhado pra embedding. É o modo que o supervisor vai spawnar.

---

## Decisões fechadas neste plano (2026-05-24)

| Decisão | Valor |
|---|---|
| Arquitetura | **1 supervisor único** (`remote-pi-supervisord`) que spawna N `pi --mode rpc` como child processes. Sem control sockets per-daemon |
| Registry | `~/.pi/remote/daemons.json` — armazena **só `cwd` + `id` derivado**. Nome, agent_name, auto_start_relay etc. moram em `<cwd>/.pi/remote-pi/config.json` (local config é fonte única) |
| ID do daemon | `sha256(realpath(cwd)).slice(0, 8)` — mesma derivação do `room_id`. Estável, derivado, 8 chars amigáveis pra CLI |
| IPC CLI ↔ supervisor | UDS dedicada em `~/.pi/remote/supervisor.sock`. NÃO usa a mesh do agent-network (separação de planos) |
| Scope de comandos | `start/stop` operam no fleet inteiro; `send <id>` mira UM daemon específico; `status` mostra todos |
| Service no SO | 1 unit (systemd) / plist (launchd) pro supervisor. Daemons não viram services independentes |
| Pareamento mobile | Acontece via Pi interativo ANTES do daemon. Daemon herda `~/.pi/remote/peers.json` e re-pareia automático via mesh-versions (plano 24 W3) |
| Tool approval | **Fora de escopo deste plano**. Daemon roda com tools livres conforme a config do Pi (responsabilidade do usuário) |
| RPC mode | Mandatório. Pi spawnado sempre com `--mode rpc -e <remote-pi/dist/index.js>` |
| Auto-start relay | Mandatório `auto_start_relay=true` no config do daemon — sem relay, daemon serve só pra mesh local (provavelmente não é o que o user quer; create força true) |

---

## Estrutura final esperada

```
remote_pi/
└── pi-extension/
    ├── src/
    │   ├── daemon/                              ← novo módulo
    │   │   ├── registry.ts                      ← daemons.json (load/add/remove)
    │   │   ├── id.ts                            ← derivação de id do cwd
    │   │   ├── supervisor.ts                    ← processo supervisord (entry: bin/supervisord.ts)
    │   │   ├── rpc_child.ts                     ← wrapper de child_process.spawn pro pi rpc
    │   │   ├── control_protocol.ts              ← shape das mensagens JSON na UDS
    │   │   └── client.ts                        ← lib pro CLI conectar no supervisor UDS
    │   ├── index.ts                             ← adiciona /remote-pi create, daemons, send, etc
    │   └── bin/
    │       └── supervisord.ts                   ← entry point do binário pi-supervisord
    ├── package.json                             ← novo bin: "pi-supervisord" → dist/bin/supervisord.js
    └── service-templates/                       ← novo
        ├── systemd.service.template
        └── launchd.plist.template
```

---

## Protocolo do supervisor UDS

Linhas JSON, 1 por mensagem. CLI conecta, envia 1 request, recebe 1 reply, fecha.

### Requests CLI → supervisor

```json
{ "op": "register", "cwd": "/Users/x/Movies" }
{ "op": "unregister", "id": "a1b2c3d4" }
{ "op": "list" }
{ "op": "start_all" }
{ "op": "stop_all" }
{ "op": "status" }
{ "op": "send", "id": "a1b2c3d4", "text": "..." }
{ "op": "restart_all" }
```

### Replies supervisor → CLI

```json
{ "ok": true, "data": <op-specific> }
{ "ok": false, "error": "human-readable" }
```

### Shape do `data` por op

- `register` → `{ "id": "a1b2c3d4", "cwd": "...", "name": "..." }`
- `list` → `{ "daemons": [{ id, cwd, name, state }] }` — state ∈ `running|stopped|crashed`
- `status` → mesmo shape de `list` + `uptime_s, last_turn_at, mesh_peer_count, relay_paired`
- `send` → `{ "id": "a1b2c3d4", "delivered": true }` ou `{ "error": "daemon not running" }`

---

## Comandos `/remote-pi` (CLI)

Comandos novos registrados em `pi-extension/src/index.ts`:

| Comando | Conecta ao supervisor? | O que faz |
|---|---|---|
| `/remote-pi create <cwd> [--name X]` | Sim (`register`) | Lê/escreve `<cwd>/.pi/remote-pi/config.json` (cria com `auto_start_relay=true` + `agent_name=X` se config não existe). Manda `register` pro supervisor com `cwd`. Devolve o `id` derivado |
| `/remote-pi daemons` | Sim (`list`) | Tabela: `ID | NAME | CWD | STATE` |
| `/remote-pi status` | Sim (`status`) | Tabela expandida com uptime, peers, pareamento |
| `/remote-pi start` | Sim (`start_all`) | Spawn de todos os daemons do registry |
| `/remote-pi stop` | Sim (`stop_all`) | Graceful shutdown de todos |
| `/remote-pi restart` | Sim (`restart_all`) | Stop all + start all |
| `/remote-pi send <id> "<prompt>"` | Sim (`send`) | Injeta prompt no daemon específico via RPC stdin do child |
| `/remote-pi remove <id>` | Sim (`unregister`) | Stop daemon + remove do `daemons.json`. Não toca no `<cwd>/.pi/remote-pi/config.json` (idempotente — `create` mesmo cwd depois funciona) |
| `/remote-pi install` | Não | Gera `~/.config/systemd/user/remote-pi-supervisord.service` (Linux) ou `~/Library/LaunchAgents/dev.remotepi.supervisord.plist` (macOS). Detecta SO automaticamente. Executa `systemctl --user enable --now` ou `launchctl load` |
| `/remote-pi uninstall` | Não | `stop_all`, depois remove o unit/plist + faz `disable`/`unload`. Mantém `daemons.json` (config persistente) |

**Comandos NÃO mudam pro Pi interativo** — todos os 8 do plano 25 (`setup`, `status`, `stop`, `pair`, `devices`, `revoke`, `set-relay` + root) continuam iguais. Os 9 novos são puramente fleet management.

---

## Lifecycle do daemon

### 1. Provisionamento

```bash
# Usuário entrou na pasta uma vez, configurou agente, fez pareamento via QR
cd ~/Movies
pi                                # roda interativo, /remote-pi pair, etc
# Agora promove a daemon:
/remote-pi create ~/Movies --name "Editor de Videos"
# Supervisor ainda não está rodando? install:
/remote-pi install
```

`create` valida:
- `cwd` existe
- `cwd` não está duplicado no registry (mesmo `id`)
- Se config local não existe, cria com `agent_name`, `auto_start_relay=true`
- Se config local existe, mantém (só adiciona ao registry)

### 2. Boot do supervisor

Quando systemd/launchd starts `remote-pi-supervisord`:
1. Lê `daemons.json`
2. Pra cada entry: faz `child_process.spawn("pi", ["--mode", "rpc", "-e", REMOTE_PI_DIST_PATH], {cwd, stdio: "pipe"})`
3. Mantém `Map<id, { child, stdinReady, stdoutBuffer, state }>`
4. Cada child, ao iniciar, roda o extension factory normalmente — `_cmdRoot` detecta config existente, faz auto-join mesh + auto-start relay (sem wizard).
5. Pra o daemon saber que está em modo daemon (pular wizard mesmo se config faltar), supervisor seta env `REMOTE_PI_DAEMON=1`. `_cmdRoot` checa essa env e em vez do wizard, falha-fast com erro no stdout JSON.
6. Supervisor binda `~/.pi/remote/supervisor.sock` e fica esperando comandos CLI.

### 3. RPC mode mechanics

`pi --mode rpc` lê comandos JSON do stdin. Cada linha é:

```json
{ "type": "command", "id": "<corr-id>", "command": "<name>", ...args }
```

Pra mandar um prompt:
```json
{ "type": "command", "id": "x1", "command": "sendUserMessage", "content": "Refactor X" }
```

(formato exato vem do Pi SDK — `rpc-types.js`/`rpc-mode.js` no node_modules/@mariozechner/pi-coding-agent).

Quando CLI manda `{op:"send", id:"a1b2c3d4", text:"..."}`, supervisor:
1. Acha `child = activeChildren.get(id)`
2. Se não existe → reply `{ ok: false, error: "daemon not running" }`
3. Senão escreve no `child.stdin` a linha JSON do RPC
4. Reply `{ ok: true, data: { delivered: true } }`

### 4. Crash handling

Supervisor escuta `child.on("exit", ...)` pra cada daemon. Em crash:
- `state` → `"crashed"`
- Loga em stderr (visível no journal/Console.app)
- Auto-restart com backoff exponencial (1s, 5s, 30s, 5min, depois desiste)
- Próximo `/remote-pi status` mostra `crashed` se ainda não conseguiu re-spawnar

Se o **supervisor** crashar, systemd/launchd restarta ele e todos os daemons sobem de novo (lê `daemons.json`).

---

## Waves

### Wave 1 — Registry + ID + create/remove (sem supervisor)

**Localização**: `pi-extension/src/daemon/`

**Mudanças**:
- `id.ts` — `daemonIdForCwd(cwd: string): string` = sha256(realpath(cwd)).slice(0, 8)
- `registry.ts` — `loadRegistry()`, `addDaemon(cwd)`, `removeDaemon(id)`, `listDaemons()`. JSON em `~/.pi/remote/daemons.json`
- `index.ts` — comandos `/remote-pi create <cwd> [--name X]` e `/remote-pi remove <id>` que mexem só no registry + config local. **NÃO** fala com supervisor ainda (ele não existe).
- Testes unitários

**Critério de aceite**:
- `create ~/foo --name X` cria `~/foo/.pi/remote-pi/config.json` com `agent_name="X"`, `auto_start_relay=true`. Adiciona `{ cwd: realpath(~/foo) }` em `daemons.json`. Devolve `id`.
- `remove <id>` tira do `daemons.json`. Config local fica intocado.
- Tentar `create` em cwd já registrado → erro idempotente
- Tentar `remove <id>` inexistente → erro claro
- `pnpm test` passa

### Wave 2 — Supervisor process + control UDS

**Localização**: `pi-extension/src/daemon/supervisor.ts`, `pi-extension/src/bin/supervisord.ts`

**Mudanças**:
- `bin/supervisord.ts` — entry point: lê registry, faz `spawn` de cada daemon, binda UDS de controle
- `supervisor.ts` — classe `Supervisor` com `start()`, `stop()`, handlers de cada op (`list`, `start_all`, `stop_all`, `send`, `status`, `register`, `unregister`)
- `rpc_child.ts` — wrapper de `child_process.spawn` que sabe falar o RPC protocol do Pi (write JSON line ao stdin)
- `control_protocol.ts` — types das messages
- `client.ts` — lib pro CLI conectar no `~/.pi/remote/supervisor.sock` e fazer request/response
- Em `index.ts`, conecta os comandos no client lib (`list/start/stop/send/restart/status`)
- `package.json` ganha `bin: { "pi-supervisord": "dist/bin/supervisord.js" }`

**Critério de aceite**:
- Rodar `pi-supervisord` em foreground: binda UDS, spawna daemons registrados
- `pnpm pi` rodar `/remote-pi daemons` mostra os daemons + state running
- `/remote-pi send <id> "echo test"` injeta no daemon, daemon processa
- Matar um daemon child com `kill <pid>` → supervisor detecta crash, marca como `crashed`
- Re-pareamento mobile funciona porque o daemon entrou normal na mesh + relay

### Wave 3 — install / uninstall + service templates

**Localização**: `pi-extension/service-templates/`, `pi-extension/src/daemon/install.ts`

**Mudanças**:
- `service-templates/systemd.service.template` (placeholders: `__USER__`, `__SUPERVISORD_PATH__`)
- `service-templates/launchd.plist.template` (mesmos placeholders + PLIST_LABEL)
- `install.ts` — detecta plataforma (linux/macos), copia template substituindo placeholders, ativa via `systemctl --user` ou `launchctl`
- `/remote-pi install` chama `install.ts`. Logs detalhados do que aconteceu (path do unit, comando de ativação, output)
- `/remote-pi uninstall` faz o inverso: stop_all via supervisor, disable + delete do unit

**Critério de aceite**:
- macOS: `remote-pi install` cria `~/Library/LaunchAgents/dev.remotepi.supervisord.plist`, faz `launchctl load`, supervisor está rodando após reboot
- Linux: `remote-pi install` cria `~/.config/systemd/user/remote-pi-supervisord.service`, faz `systemctl --user enable --now`, status `active`
- `remote-pi uninstall` reverte ambos. Daemons param mas registry persiste pra próximo install
- README com instruções específicas pra cada SO

### Wave 4 — Documentation + smoke tests

**Localização**: `pi-extension/README.md`, `pi-extension/docs/daemon.md`

**Mudanças**:
- Seção nova no README explicando o fluxo provisionamento → install → usage
- `docs/daemon.md` com cenários de troubleshooting (daemon crashed, supervisor não inicia, etc)
- Smoke test manual: 3 daemons em pastas diferentes, install, reboot, status, send, uninstall

**Critério de aceite**:
- Usuário consegue seguir o README e ter 1 daemon rodando 24/7
- README cobre: como ver logs (`journalctl --user -u remote-pi-supervisord` / `log show --predicate 'subsystem == "dev.remotepi"'`)
- Manual smoke test passa

---

## Definition of Done

### Wave 1 — Registry + create/remove
- [ ] `daemonIdForCwd(cwd)` retorna sha256 truncado, estável
- [ ] `daemons.json` schema documentado (só `cwd` por entry)
- [ ] `/remote-pi create` + `/remote-pi remove` funcionam standalone
- [ ] Validação: cwd duplicado, cwd não-existente, id inexistente
- [ ] Testes unitários cobrem add/remove/list

### Wave 2 — Supervisor + UDS
- [ ] `pi-supervisord` é instalável via `pnpm` como bin
- [ ] Spawn de `pi --mode rpc` per daemon, stdin/stdout pipes mantidos
- [ ] UDS `~/.pi/remote/supervisor.sock` aceita ops `list/start/stop/send/status/restart/register/unregister`
- [ ] Crash de child → state `crashed` + auto-restart com backoff
- [ ] Daemons herdam config local sem rodar wizard (env `REMOTE_PI_DAEMON=1` pula)
- [ ] `/remote-pi send <id> "text"` é entregue ao daemon e o agente processa

### Wave 3 — install / uninstall
- [ ] Templates systemd + launchd com placeholders
- [ ] `install` detecta SO, gera unit/plist, ativa
- [ ] `uninstall` reverte completamente
- [ ] Reboot do SO → supervisor sobe sozinho, daemons sobem juntos
- [ ] Logs acessíveis via `journalctl` / `log show`

### Wave 4 — Docs
- [ ] README seção "Daemon mode" com walk-through completo
- [ ] `docs/daemon.md` com troubleshooting
- [ ] Smoke test documentado e validado manualmente

---

## Trade-offs explícitos

- **Tool approval fica fora deste plano.** Daemon roda com tools livres (Bash, Edit, Write). Usuário é responsável por configurar permissions do Pi adequadas pro contexto. Tool approval via mobile pode entrar em plano futuro reusando o canal E2E do W2D.
- **Supervisor é SPOF (single point of failure).** Se ele cai, todos os daemons descem. Mitigação: systemd/launchd reinicia ele automaticamente. Cabos lógicos: se 1 daemon trava, outros não são afetados (cada child é isolado).
- **`send <id>` é fire-and-forget.** Não retorna a resposta do agente — a resposta sai pelo relay/UDS normal (mobile vê, outros daemons na mesh veem). Pra capturar resposta, escutaria os stdout do child no supervisor — complexidade que fica pra evolução.
- **Daemons compartilham o keypair Ed25519** com o Pi interativo da mesma pasta. Não há isolação de identidade — comprometer um daemon = comprometer o pareamento daquela pasta. Aceito porque é a mesma machine, mesmo usuário.
- **`remote-pi remove` não deleta o config local.** Idempotência: rodar `create` de novo no mesmo cwd reusa o config existente. Pra remover de verdade, `rm -rf <cwd>/.pi/remote-pi/`.
- **Pareamento mobile ainda passa pelo Pi interativo.** Daemon não mostra QR (sem TTY). Workflow esperado: pareia uma vez via Pi normal, daemon herda `peers.json` global.

---

## Não-objetivos

- **Sem isolation/sandbox per-daemon.** Cada daemon é só um child process Pi normal. Não há container, namespace, ou user-separation.
- **Sem multi-machine fleet management.** Supervisor gerencia daemons da mesma máquina. Pra controlar N máquinas, plano separado (provavelmente baseado em mesh-versions do plano 24).
- **Sem hot-reload de config.** Mudar `<cwd>/.pi/remote-pi/config.json` → precisa de `remote-pi restart` do daemon.
- **Sem queue/job system.** `send <id>` é síncrono e simples. Se virar dor (jobs paralelos, prioridades), plano separado.

---

## Próximos planos

- **`plan/27-tool-approval.md`** — gate de aprovação de tools (Bash/Edit/Write) pra daemons, via mobile push. Reusa o canal E2E do W2D.
- **`plan/28-daemon-multimachine.md`** — fleet management cross-machine via mesh-versions (qual daemon roda em qual máquina, descobrir via owner-sk).
- **`plan/29-daemon-job-queue.md`** — sistema de fila pra `send` paralelo, prioridades, replay de jobs falhados (se virar necessidade real).
