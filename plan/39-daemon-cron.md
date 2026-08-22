# 39 — Cron de daemons (agendar prompts recorrentes via supervisor)

## Contexto

O supervisor (plano 26) já roda 24/7, mantém a frota de daemons (`pi --mode rpc`
por pasta) e já injeta prompt via `_opSend → RpcChild.sendPrompt` (stdin
`{type:"prompt"}`, entrega confiável mid-turn — plano 34 enfileira). Falta a
camada de **agendamento**: disparar prompts **recorrentes** num daemon (ex.: "todo
dia 9h, resuma as PRs novas") + um **log auditável** do que rodou e do que foi
pulado.

> **Origem**: handoff do pane `Extension`
> (`.orchestration/results/handoff-daemon-cron.md`, 2026-06-07). Design **fechado
> com o usuário**; promovido a plano pelo Orquestrador. Implementação fica no pane
> `Extension`.

### Não confundir camadas (importante)

Isto é cron de **daemons Pi** (a frota do supervisor desta extensão). É **outra
coisa** do `/schedule` e do `/loop` do Claude Code, que agendam **agentes
Claude**. Camadas distintas, donos distintos — não unificar nem citar uma pela
outra.

### Relação com planos existentes

- **Plano 26 (daemon mode)** é o baseline: supervisor, `RpcChild`, control UDS,
  `registry.ts` (`daemons.json`). Este plano **estende** o supervisor, não o
  substitui.
- **Plano 34 (entrega confiável)**: `sendPrompt` a daemon mid-turn é entregue
  (harness enfileira) — base do `fireJob`.
- **Pré-requisito duro**: só funciona com o **supervisor instalado como serviço**
  (`remote-pi install`, plano 26). Sem serviço, sem cron — o CLI **avisa**.

## Decisões fechadas (2026-06-07)

| # | Decisão | Valor | Por quê |
|---|---|---|---|
| **A** | Onde vive o scheduler | **In-process no `Supervisor`** (não timers do SO) | O serviço systemd/launchd do supervisor já dá a resiliência; um scheduler interno evita um 2º mecanismo de agendamento do SO |
| **B** | Parser de cron-expr | **`croner`** (dep nova) | ESM puro, zero-dep, suporta timezone — aderente à regra "só dep ESM-friendly" do pi-ext. Não inventar parser |
| **C** | Overlap / pileup | **`skip_if_busy`** (pula se o daemon está mid-turn) **+ intervalo mínimo 60s** | Cada disparo gasta tokens; sem isso, jobs curtos empilham em cima de turnos não terminados |
| **D** | Forma do CLI | **top-level `remote-pi cron …`** (não aninhado em `daemon`) | Cron opera sobre a frota inteira, não sobre um daemon específico — top-level reflete isso |
| **E** | Auditoria | **Log JSONL obrigatório** em `~/.pi/remote/cron.jsonl` (1 linha por disparo OU skip) | Saber **exatamente** o que rodou e o que não rodou; a saída do agente é fire-and-forget pro mesh, então o disparo precisa de trilha própria |

## Estrutura esperada (componentes — pi-extension)

| Arquivo | Papel |
|---|---|
| **novo** `src/daemon/cron_registry.ts` | persiste `~/.pi/remote/cron.json` (molde do `daemons.json`); CRUD dos jobs |
| **novo** `src/daemon/cron_log.ts` | append em `~/.pi/remote/cron.jsonl`; leitura com tail |
| `src/daemon/supervisor.ts` | objetos `Cron` (croner) por job; `fireJob`; reconciliação; novas ops |
| `src/daemon/rpc_child.ts` | flag `isBusy` (derivada do stream RPC; fallback `get_state.isStreaming`) |
| `src/daemon/control_protocol.ts` | ops `cron_add/list/remove/enable/run/log` + shapes |
| `src/daemon/client.ts` | helpers tipados CLI↔supervisor pras ops novas |
| `src/index.ts` | roteamento `/remote-pi cron …` + bloco CLI standalone (`_isDirectRun`) |
| `package.json` | `+ croner` |
| `pi-extension/README.md` | adicionar `remote-pi cron …` à tabela **"Daemon fleet"** (já existe, ~`:375`) + subseção curta (cron-expr, regra ≥60s, `tz`, pré-requisito) |

> **Doc user-facing (pane `Site`)**: o **tutorial de daemon já existe**
> (`site/src/app/tutorials/daemon`, página TSX) → ganha uma seção "agendar prompts
> recorrentes"; a **referência do comando** entra em `site/src/app/docs`. Regra do
> site: **sem screenshots** — validar só com `pnpm lint && pnpm build`.

### Shape do job (`cron.json`)

```jsonc
{ "jobs": [{
  "id": "j_ab12", "daemon_id": "<id>", "schedule": "0 9 * * *",
  "tz": "America/Sao_Paulo", "prompt": "Resuma as PRs novas", "enabled": true,
  "skip_if_busy": true, "wake": false, "catchup": false,
  "created_at": "…", "last_run": "…", "last_status": "delivered"
}]}
```

### Linha do log (`cron.jsonl`)

```jsonc
{ "ts": 1733570400123, "job_id": "j_ab12", "daemon_id": "<id>",
  "schedule": "0 9 * * *", "fired": true, "result": "delivered",
  "prompt_preview": "Resuma as PRs novas" }
```

`result` ∈ `delivered | deliver_failed | woke_and_delivered | skipped_busy |
skipped_down | skipped_disabled`. O `last_status` no `cron.json` é o atalho pro
`cron list`; o JSONL é o histórico completo.

### Lógica do `fireJob` (callback do `Cron`)

```
fireJob(job):
  slot = children.get(job.daemon_id)
  !slot || !running → job.wake ? (start + enviar → woke_and_delivered) : skip("skipped_down")
  job.skip_if_busy && slot.busy → skip("skipped_busy")
  senão → sendPrompt(job.prompt) → delivered | deliver_failed
  grava last_run/last_status no cron.json + APPEND no cron.jsonl (sempre, inclusive skips)
```

### CLI

```
remote-pi cron add <daemonId> "<cron-expr>" "<prompt>" [--tz …] [--wake] [--no-skip-busy] [--catchup]
remote-pi cron list                       # schedule, enabled, last_run/last_status, nextRun
remote-pi cron remove <jobId>
remote-pi cron enable|disable <jobId>
remote-pi cron run <jobId>                # dispara agora (ignora schedule)
remote-pi cron log [<jobId>] [--tail N]   # lê o cron.jsonl
```

## Passos (com critério de aceite)

1. **Dep + registry** — adicionar `croner`; `cron_registry.ts` (CRUD em
   `cron.json`, molde do `daemons.json`; ids tipo `j_<rand>`; cwd-agnóstico).
   - *Aceite*: testes de CRUD (add/list/remove/enable) round-trip no `cron.json`;
     `croner` importa em ESM sem warning; `tsc` limpo.

2. **Log JSONL** — `cron_log.ts`: append atômico em `~/.pi/remote/cron.jsonl` +
   leitura com tail por `job_id`.
   - *Aceite*: append de N linhas → tail N devolve as últimas; filtro por `job_id`
     funciona; arquivo ausente não é fatal (cria).

3. **Flag `isBusy` no `RpcChild`** — derivada do stream RPC (turn aberto do início
   do streaming até `response{command:"prompt"}`/`message_end`); exposta como
   `slot.child.isBusy`. **Fallback autoritativo**: `get_state.isStreaming`.
   - *Aceite*: teste com stream simulado abre/fecha `isBusy` nos marcadores certos;
     fallback `get_state.isStreaming` cobre o caso de marcador ambíguo.
   - **A fixar na impl (detalhe 1)**: os marcadores exatos de abertura/fecho do
     turn — confirmar contra os tipos de evento do SDK do Pi.

4. **Scheduler no Supervisor** — um objeto `Cron` (croner) **por job** (gerencia
   próprios timers + tz); **reconciliar** os `Cron` vivos em `start()` e em cada
   `cron_add/remove/enable`. Callback = `fireJob` (lógica acima).
   - *Aceite*: `fireJob` cobre os 4 ramos — `delivered` (daemon vivo, ocioso),
     `skipped_busy` (mid-turn + skip_if_busy), `skipped_down` (daemon parado, sem
     wake), `woke_and_delivered` (parado + `wake`); cada um grava `last_status` +
     1 linha no JSONL. Reconciliação: add cria `Cron`, remove/disable o destrói,
     `start()` recria a partir do `cron.json`.

5. **Ops de controle + CLI** — `cron_add/list/remove/enable/run/log` no
   `control_protocol.ts` (+ shapes) e `client.ts` (helpers); roteamento
   `/remote-pi cron …` no `index.ts` + bloco CLI standalone. `cron_add` **valida**:
   expr via croner, **intervalo ≥ 60s** (rejeita mais frequente), e **avisa se o
   supervisor não está rodando**.
   - *Aceite*: `cron add` rejeita expr inválida e intervalo <60s com mensagem
     clara; `cron list` mostra `nextRun`; `cron run` dispara ignorando schedule;
     `cron log --tail` lê o JSONL; supervisor-down → aviso (não crash).

6. **`pnpm test` + `tsc` verdes** com os casos novos (registry, log, parse +
   min-interval, fireJob nos 4 ramos, reconciliação).

7. **Documentação (cross-pane — depois da feature verde)**
   - **`Extension`** — `pi-extension/README.md`: adicionar `remote-pi cron …` à
     tabela "Daemon fleet" (`:375`) + subseção curta com o formato cron-expr, a
     regra ≥60s, `tz`, os resultados do log e o **pré-requisito** (supervisor como
     serviço). Apontar pro tutorial do site pro passo-a-passo.
   - **`Site`** — estender o tutorial de daemon (`site/src/app/tutorials/daemon`)
     com "agendar prompts recorrentes": `install` do supervisor → criar daemon →
     `cron add` → conferir com `cron list`/`cron log`; pré-requisito em destaque.
     Acrescentar a referência dos 6 subcomandos em `site/src/app/docs`.
   - *Aceite*: README lista os 6 subcomandos `cron` + a validação (≥60s,
     supervisor-up); o tutorial cobre o fluxo end-to-end com o pré-requisito
     evidente; **`pnpm lint && pnpm build` do site verdes** (sem screenshots).

## Detalhes a fixar na implementação (não bloqueiam o plano)

1. **Marcadores de busy** no stream RPC — qual evento abre e qual fecha o turn.
   `get_state.isStreaming` é o fallback autoritativo se o stream for ambíguo.
2. **Catchup** via croner `.previousRun()` — detectar **1** run perdido enquanto o
   supervisor esteve fora. **Default OFF**, opt-in por job (`--catchup`), no
   **máximo 1×** (não re-disparar histórico inteiro).

## DoD

> **pi-ext implementado 2026-06-07** (dispatch `39-daemon-cron` → pane Extension,
> ainda **NÃO commitado**): `tsc` limpo, `pnpm test` **498/498**. Os 2 detalhes
> parkados foram resolvidos: **busy** → `message_*` é só hint (o SDK não tem evento
> de fecho de turn; `response{command:prompt}` sai no preflight), fonte
> autoritativa é `get_state.isStreaming` via `refreshBusy()`; **catchup** →
> `croner.previousRun()`, default-OFF, opt-in, máx 1×. Falta: doc do site +
> consolidação (commit). Detalhes em `.orchestration/results/39-daemon-cron.md`.

- [x] **Registry + log** — `cron_registry.ts` (CRUD em `cron.json`) e `cron_log.ts`
      (append/tail em `cron.jsonl`) com testes
- [x] **Busy** — flag `isBusy` no `RpcChild` (stream + fallback `isStreaming`) testada
- [x] **Scheduler** — `Cron`/job no Supervisor + `fireJob` cobrindo os 4 resultados
      (delivered/skipped_busy/skipped_down/woke_and_delivered) + reconciliação em
      start/add/remove/enable
- [x] **CLI + ops** — `remote-pi cron add/list/remove/enable/disable/run/log`; validação
      (expr, intervalo ≥60s, supervisor-up); standalone + `/remote-pi cron …`
- [x] **Auditoria** — toda execução E todo skip geram 1 linha no `cron.jsonl`;
      `last_status` no `cron.json` reflete o último
- [x] **`croner`** adicionado (`@10.0.1`); `pnpm test` (498/498) + `tsc` verdes
- [x] **Documentação** — `remote-pi cron` no README do pi-ext (tabela "Daemon
      fleet") ✅ (commitado `a7a40ed`); tutorial `tutorials/daemon` (seção cron +
      pré-requisito em `Callout` de destaque) + referência dos 7 subcomandos em
      `docs` ✅ (pane Site, `pnpm lint && build` verdes — **uncommitted**, publica
      via `push-docker.sh` junto/depois do release que contém `remote-pi cron`)

## Riscos / edge cases

- **Custo de tokens**: cada disparo gasta tokens. Mitigado por min-interval 60s +
  `skip_if_busy`. A saída do agente vai fire-and-forget pro relay/mesh; o cron só
  **audita o disparo**, não a resposta.
- **Timezone / DST**: persistir `tz` por job; croner resolve a conversão.
- **Supervisor offline**: sem serviço instalado, não há scheduler — o CLI avisa em
  vez de fingir que agendou.
- **Pileup**: o min-interval + `skip_if_busy` evitam empilhar disparos sobre um
  turno não terminado; o catchup limitado a 1× evita avalanche pós-downtime.

## Próximos planos / evolução

- **Histórico/observabilidade na UI** (app): expor `cron list` + `cron log`
  numa tela — fora do escopo deste plano (que é o motor + CLI).
