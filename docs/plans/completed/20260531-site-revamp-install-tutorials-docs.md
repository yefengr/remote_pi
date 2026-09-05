> **历史归档。** 原始路径：`plan/33-site-revamp-install-tutorials-docs.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 33 — Revamp do Site: install curl, Tutoriais e Doc→Referência

**Objetivo**: enxugar a home (hoje inchada com 2–3 walkthroughs de install) e a
doc (página única de 1273 linhas), reposicionando Remote Pi como **plugin do Pi**
com onboarding de baixa fricção. Três frentes novas no site: (1) **install curl**
de um comando como herói, (2) uma **seção de Tutoriais** mão-na-massa irmã da Doc,
(3) uma página de decisão **"Por que Pi"**; e a Doc reduzida a **Referência**.

Resultado esperado: o visitante entende em 5 segundos que é "controle remoto pros
seus agentes de código pelo celular", instala com **um comando**, aprende a usar
por **tutoriais guiados**, e consulta detalhes numa **referência enxuta** — sem ver
a mesma coisa escrita em três lugares.

## Por que essa direção (consenso da entrevista 2026-05-31)

A home tenta ser landing + tutorial + referência ao mesmo tempo, e a doc empilha
aprender/executar/consultar num scroll só. O remédio não é cortar conteúdo — é
**dar endereço certo pra cada tipo** (Diátaxis): tutorial = aprender fazendo;
referência = consultar sob demanda; decisão = convencer antes do install.

### Decisões fixadas (entrevista)

| # | Decisão | Valor |
|---|---|---|
| 1 | **Posicionamento da home** | "Plugin do Pi" — vocabulário do Pi, simples. Gateway/standalone (OpenClow/Hermes) sai do hero, vira tutorial avançado |
| 2 | **Install** | Componente de **abas** (EN): aba **"No Pi yet"** → curl one-liner; aba **"Already have Pi"** → `pi install npm:remote-pi` → `/remote-pi` (wizard) → `/remote-pi pair`. A aba curl só **acende quando a Wave 0 existir**; "Already have Pi" entra já. (`/remote-pi install` = camada daemon → tutorial) |
| 3 | **Promessa do Hero** | "Control all your agents from your phone — at once." (remote-control; pluralidade como substrato, não mesh-cêntrico) |
| 4 | **De-bloat da home** | **Moderado**: mantém Quick start (só curl) + 6 features + estrutura; encolhe Daemon mode pra teaser; consolida CTAs |
| 5 | **Tutoriais** | **Seção separada** (irmã de Docs no nav). Currículo: (1) Getting Started c/ App, (2) Mesh local, (3) Mesh remota, (4) Daemon how-to |
| 6 | **"Por que Pi"** | Página de **decisão** linkada do hero (vivo 24/7, leve, extensível). Comparação **auto-focada** no eixo *agente always-on*: **OpenClaw** e **Hermes Agent** como concorrentes do **modo daemon/Supervisor** (só afirma propriedades do Pi). Daemon *how-to* fica no tutorial |
| 7 | **Doc** | Vira **Referência** enxuta; seções tutorial-flavored encolhem a 1 parágrafo + ponteiro "→ ver tutorial X" |
| 8 | **Curl installer** | **Não existe ainda** → pré-requisito (pi-extension). Aba "No Pi yet" (curl) só acende quando a Wave 0 rodar; aba "Already have Pi" entra já |
| 9 | **Substrato de conteúdo** | **JSX literal**, sem MDX (mantém Plano 22). Reusa `DocsSection`/`CodeBlock`; novos componentes compartilhados: abas de install, callout, prev/next |

### Revisão explícita do Plano 27 (Wave D)

Plano 27-D fixou a copy da home como *"mesh de agentes / seus terminais conversam
entre si; celular é só autenticador"*. **Este plano reverte conscientemente essa
direção**: o enquadramento mesh **sai do hero** e migra pros tutoriais de Mesh
local/remota. O hero passa a "controle todos os seus agentes pelo celular". Não é
mudança silenciosa — está registrada aqui; 27-D fica historicamente válido até a
Wave A deste plano aterrissar.

## Restrições inegociáveis

- **Inglês only** (Plano 22). Copy renderizada em inglês mesmo que a entrevista
  seja em PT. Hero EN: *"Control all your agents from your phone — at once."*
- **Sem afirmar E2E** (memory `project_no_e2e_yet`). O relay vê plaintext; o que
  existe é **TLS em trânsito + pairing Ed25519**. Copy diz "encrypted in transit",
  **nunca** "end-to-end". Crítico no tutorial de **Mesh remota**.
- **OpenClow/Hermes sempre tratados como excelentes**. A vantagem do Pi é
  enquadrada como **leve + extensível + vivo 24/7** ("você monta o seu, não vem
  inchado"), nunca como "os outros são ruins".
- **Sem screenshots no site** (memory `feedback_no_site_screenshots`). Verificação
  = `pnpm lint && pnpm build`. Sem verificação visual.
- **Site não promete o que não roda**: o `curl … | bash` só vira herói depois que
  a Wave 0 existir e for testada num ambiente limpo.
- **JSX literal** — decisão **mantida** (entrevista 2026-05-31), **sem MDX**.
  Reusar os primitivos existentes (`DocsSection`, `DocsSubsection`, `CodeBlock`) e
  criar os compartilhados que faltam: **abas de install**, **callout/heads-up** e
  **navegação prev/next** dos tutoriais. Consistente com o Plano 22.

## Estrutura esperada (site)

```
src/app/
  page.tsx                 # home (Wave A): hero novo, quick start curl, daemon teaser
  why/page.tsx             # NOVO (Wave B): "Por que Pi" — decisão + comparação
  tutorials/
    page.tsx               # NOVO (Wave C): índice da seção
    getting-started/…      # tutorial 1 (inclui App)
    mesh-local/…           # tutorial 2
    mesh-remote/…          # tutorial 3
    daemon/…               # tutorial 4 (how-to)
  docs/page.tsx            # Wave D: reduzida a Referência + ponteiros
  components/header.tsx    # nav ganha "Tutorials" ao lado de "Docs"
  install.sh (rota/estática)  # Wave 0 hospeda o one-liner sob o domínio do site
```

## Fases

**Dois panes, dois ritmos.** A **Wave 0** roda no pane **Extension** e corre **em
paralelo** com tudo — as Waves de site não dependem dela (usam a aba "Already have
Pi" desde já). As **Waves A–D rodam no mesmo pane Site**, logo são **seriais entre
si** — não há paralelismo dentro do site. A **Wave E** é o "merge" final: acende a
aba "No Pi yet" com o curl real; depende da Wave 0 **e** de a Wave A já existir.

**Ordem serial no Site** (cada uma encadeia na anterior por componentes/links):

| Ordem | Wave | Por que nessa posição | Bloqueio |
|---|---|---|---|
| 1º | **A** — home + componentes | Cria os compartilhados (abas, callout, prev/next, nav "Tutorials") que B/C reusam | — |
| 2º | **B** — "Por que Pi" | Pequena; resolve o link *why* do teaser da Wave A | **lastro**: confirmar OpenClow/Hermes |
| 3º | **C** — Tutoriais | Maior peça; resolve os links de tutorial do teaser (A) e os ponteiros da doc (D) | — |
| 4º | **D** — Doc→Referência | Os ponteiros "→ ver tutorial X" só resolvem com as rotas da Wave C no ar | depende de **C** |
| ⧖ | **E** — aba curl real | A qualquer momento após **A** **e** **Wave 0** fecharem | **Wave 0** |

> B e C podem trocar de ordem (B é pequena e independente de C); o resto é fixo.
> Links internos pra rotas ainda-não-criadas **não quebram o `build`** — ficam
> mortos só até a Wave que cria a rota aterrissar.

---

### Wave 0 — Curl installer (pi-extension) · pré-requisito

**Despachar pro pane `Extension`.** Script de bootstrap zero→rodando, invocável por
`curl -fsSL https://remote-pi.jacobmoura.work/install.sh | bash`.

Passos do script (**idempotente, sem `sudo` — tudo user-space**; detecta macOS/Linux):
1. **Node** — usa o do sistema se já houver ≥ versão mínima; senão instala via nvm
   em `~/` (sem root, sem pisar no Node do sistema)
2. Instala o **Pi** (CLI do agente). **Resolvido (Wave 0)**: pacote npm
   `@mariozechner/pi-coding-agent` (bin `pi`), via `npm i -g --prefix ~/.local`
   (user-space, sem root). Plugin cai em `~/.pi/agent/npm/node_modules/`
3. Instala o **plugin remote-pi** (`pi install npm:remote-pi`)
4. **Linka a CLI** `remote-pi` em `~/.local/bin/`
5. Instala o **supervisor de usuário** (launchd GUI agent no macOS / `systemd
   --user` no Linux) — reuso do caminho de `/remote-pi install`
6. **Não pareia.** Imprime o próximo passo (parear o celular) e encerra

Decisões de implementação:
- **Hospedagem**: `install.sh` versionado no repo e servido pela rota estática do
  site (domínio canônico) → o site é dono do one-liner. Wave 0 entrega o script; a
  rota é plumbing trivial na Wave A/E.
- **OS** (decisão fechada): **macOS + Linux nativo**. **Windows → mensagem "use
  WSL"** (tratado como Linux), sem suporte nativo — não há launchd/systemd; Task
  Scheduler/Service fica pra plano futuro se houver demanda.
- **Versão**: instala a versão publicada **mais recente** do plugin e **imprime o
  que instalou**.
- **Trust**: zero `sudo`; documentar "leia antes de rodar" e expor o `.sh` legível
  (padrão nvm/rustup).

**DoD Wave 0**:
- [x] Script entregue: `pi-extension/install.sh` — user-space, sem `sudo`, idempotente, legível
- [x] Pi-install resolvido: npm `@mariozechner/pi-coding-agent` via `npm i -g --prefix ~/.local`
- [x] Windows imprime "use WSL" e sai 0 (não tenta instalar)
- [x] `pnpm test` (426/426) + `pnpm typecheck` no pi-extension OK
- [ ] **Smoke-test em ambiente limpo** (gate da Wave E): macOS limpo + container
      Ubuntu deixam o **supervisor de usuário vivo sem sudo** (launchd / `systemd
      --user`); 2º run no-op; Node ausente → instala via nvm

> **Correção de DoD**: o passo 6 **não pareia** (decisão do plano), então o
> critério é **supervisor up sem parear**, não "daemon vivo no mesh" — isso
> exigiria `remote-pi create` + pairing manual, fora do escopo da Wave 0.

> **Smoke-test Docker Ubuntu (2026-05-31) — BLOQUEIO encontrado**: passos 1–2 OK
> (Node 22 via nvm; `pi` instalado em `~/.local/bin`), mas **passo 3 FALHOU** —
> `pi install npm:remote-pi` rodou mas `~/.pi/agent/npm/node_modules/remote-pi/dist/index.js`
> **não existe** → script morre (exit 1). Invisível na máquina de dev (plugin
> pré-existente); só aparece em ambiente limpo. **Wave 0 reaberta** (fix despachado
> pro Extension); **Wave E segue bloqueada**.
> Achado 2: `@mariozechner/pi-coding-agent@0.73.1` está **deprecated** → upstream
> pede `@earendil-works/pi-coding-agent`. **Decisão (usuário 2026-05-31): migrar
> agora pra `@earendil-works/pi-coding-agent@^0.78.0`** ("não tem muitas mudanças")
> — despachado como **Wave 0c**. Afeta package.json/imports + install.sh + CLAUDE.md.

> **Fix (2026-05-31)**: causa-raiz NÃO era publish — `pi install npm:remote-pi`
> instala em `npm root -g`, não no `~/.pi/agent/npm` que o script tinha hardcoded.
> `install.sh` corrigido: `resolve_plugin_dist()` via `npm root -g` + força prefix
> user-space + guard acionável. Só no install.sh, **sem republicar**.
> **Re-teste (2026-05-31) FALHOU**: o `export npm_config_prefix=~/.local` quebra o
> nvm (`nvm is not compatible with npm_config_prefix`, exit 11) — Node nem instala.
> 2ª iteração despachada: tornar o prefix **condicional** (não setar no caminho nvm).

> **Smoke v3 (2026-05-31) — VERDE** (clean Ubuntu): Node nvm → Pi → plugin
> (resolvido via `npm root -g` no node-root do nvm) → CLI link → supervisor,
> `SCRIPT_EXIT=0`. **Mecanismo de install Linux validado.** Quirk de polish:
> `remote-pi install` imprime `systemctl ENOENT` no container (sem systemd) mas
> reporta sucesso — inócuo no container e real num box com systemd, mas **num Linux
> headless sem systemd ele mente** (diz que subiu sem subir). Item separado.
> Falta: smoke v4 pós-migração `@earendil`; teste macOS limpo (launchd); 2º-run no-op.

> **Smoke v4 (2026-05-31, pós-`@earendil`) — FALHOU, achado de versão**: o Pi
> **0.78** instala o plugin em `~/.pi/agent/npm/node_modules/remote-pi/` — **não**
> em `npm root -g` (comportamento do 0.73). O `resolve_plugin_dist()` (só checava
> `npm root -g`) errou o alvo. Fix#3: checar **ambos** (`~/.pi/agent/npm` primeiro,
> depois `npm root -g`). Despachado. Lição: re-smokar pós-migração era essencial.

> **Smoke v5 (2026-05-31, `@earendil` + dual-path) — VERDE TOTAL** (clean Ubuntu):
> 1º run `SCRIPT_EXIT=0` (Pi @earendil → plugin em `~/.pi/agent/npm` → CLI link →
> supervisor); **2º run no-op idempotente** (`SCRIPT_EXIT=0`, tudo "skipping").
> **Installer Linux FECHADO.** Resta só (release/manual): republish do remote-pi
> contra `@earendil`, teste macOS launchd, e a Wave E (servir + acender a aba).

---

### Wave A — Home de-bloat (site) · moderado

**Despachar pro pane `Site`.** Toca `src/app/page.tsx`, `src/components/hero.tsx`,
`src/components/header.tsx`.

- **Hero**: trocar a promessa mesh por **"Control all your agents from your phone
  — at once."** H1 "Remote Pi" mantém. Botão primário → Quick start. Botão
  secundário → GitHub. (Estrutura do hero preservada: logo, H1, 2 botões.)
- **Install (componente de abas, EN)**: substituir o Quick start atual por um
  bloco de **2 abas**:
  - **"No Pi yet"** → o one-liner `curl -fsSL https://remote-pi.jacobmoura.work/install.sh | bash`.
    **Acende só quando a Wave 0 aterrissar** — até lá, aba desabilitada com
    "Coming soon" (ou oculta).
  - **"Already have Pi"** → mostra **três comandos** (caminho básico correto,
    confirmado no CLI): `pi install npm:remote-pi` → `/remote-pi` (wizard que cria
    o config) → `/remote-pi pair`. **Disponível desde já** (não depende da Wave 0).
  - **`/remote-pi install` saiu da home** — é a camada **daemon/supervisor**, vai
    pro tutorial do daemon (Wave C). Achado da Wave A: `/remote-pi install` só
    instala o supervisor; `/remote-pi pair` num cwd novo falha sem o wizard que
    cria o config.
  - Remove a duplicação de comandos que existe hoje (Quick start 3-step vs Daemon
    4-step).
- **Daemon mode**: **encolher** o bloco de 4 `DaemonStep` pra um **teaser de 1
  card** que linka `/why` (decisão) + `/tutorials/daemon` (how-to). Tirar o
  passo-a-passo da home.
- **Features**: manter as **6**, mas revisar a copy de "Mesh across machines" e
  "Works with the harness" pra não brigar com "plugin do Pi" (mesh = feature
  avançada, não manchete).
- **CTA**: consolidar os **2 CTAs de GitHub** em **1** no rodapé da página.
- **Header nav**: adicionar "Tutorials" (aponta pra `/tutorials`, criada na Wave C).

**DoD Wave A**:
- [ ] Hero com a promessa nova (EN), sem copy mesh-cêntrica
- [ ] Install em **abas** ("No Pi yet" / "Already have Pi"), não 2–3 blocos soltos
- [ ] Aba "No Pi yet" desabilitada/"Coming soon" enquanto a Wave 0 não fecha
- [ ] Daemon mode reduzido a teaser com 2 links (why + tutorial)
- [ ] 6 features preservadas, copy revisada; 1 CTA único
- [ ] `pnpm lint && pnpm build` OK

---

### Wave B — Página "Por que Pi" (site) · decisão

**Despachar pro pane `Site`.** Nova rota `src/app/why/page.tsx`, linkada do hero e
do teaser de daemon.

- Conteúdo de **decisão** (pré-install): Pi como **agente vivo 24/7**, **leve**,
  **extensível** (instala as skills/plugins que quiser — você monta o seu).
- **Eixo da comparação**: *agente always-on / background*. **OpenClaw** e
  **Hermes Agent** são concorrentes do **modo daemon/Supervisor** do Pi — não do
  Pi como um todo.
- **Comparação auto-focada** (formato fechado): a página **só afirma propriedades
  do Pi**; OpenClaw e Hermes Agent são citados como **excelentes agentes always-on
  open-source**, **sem afirmar os internals deles**. Comparativa no **tom** ("quer
  uma plataforma always-on completa? eles são ótimos; quer um coding agent **leve
  que você monta** e deixa vivo 24/7 + controla pelo celular? Pi + remote-pi"),
  **não em tabela**.
- **Lastro** (pesquisa 2026-05-31, nomes confirmados pelo usuário):
  - **OpenClaw** (ex-*clawdbot/moltbot*) — agente autônomo open-source; *gateway
    daemon* persistente (systemd/LaunchAgent) com heartbeat; roda coding agents em
    background; orientado a VM/cloud pra always-on.
  - **Hermes Agent** (Nous Research) — agente open-source self-hosted; serviço
    systemd, memória entre sessões, responde via Telegram/Slack, cria skills
    sozinho, sobrevive a reboot; na própria máquina ou VPS.
  - **Ângulo do Pi**: *coding agent* enxuto que você **monta** (skills/plugins/
    agents por pasta); o **remote-pi** adiciona supervisor always-on + **controle
    pelo celular** + mesh, sem empacotar um framework pesado. Open source, relay
    self-hostable.
- **Sem E2E**; sem screenshots.

**DoD Wave B**:
- [ ] Rota `/why` no ar, linkada do hero + teaser de daemon
- [ ] Comparação **auto-focada**: zero afirmação sobre internals de OpenClow/Hermes
- [ ] Eles citados como excelentes; vantagem do Pi = leve/extensível/24-7
- [ ] Nomes/posicionamento de **OpenClaw** e **Hermes Agent** corretos (confirmados 2026-05-31)
- [ ] Nenhuma afirmação de E2E
- [ ] `pnpm lint && pnpm build` OK

---

### Wave C — Seção Tutoriais (site) · 4 tutoriais

**Despachar pro pane `Site`.** Nova rota `src/app/tutorials/` + índice; irmã de
Docs no nav. **Substrato: JSX literal** (decisão fechada — sem MDX), reusando
`DocsSection`/`CodeBlock` e os componentes compartilhados (abas de install,
callout, prev/next) criados na Wave A.

1. **Getting Started** (inclui o App): install (curl quando pronto / in-Pi
   interino) → pair → **primeiro comando do celular**. É o âncora; não esquecer o
   lado do App.
2. **Mesh local**: como os agentes se enxergam e conversam no broker local
   (`list_peers`, `agent_send`).
3. **Mesh remota**: roteamento cross-PC via relay. Copy "encrypted in transit",
   **nunca** E2E. Mencionar que "Delivered" = broker aceitou, não "peer vivo"
   (memory `project_mesh_delivered_not_alive`).
4. **Daemon (how-to)**: supervisor, `remote-pi create`, manter vivo 24/7, fleet
   ops. O *por que* mora em `/why`, não aqui.

**DoD Wave C**:
- [ ] Nav header com "Tutorials" ao lado de "Docs"
- [ ] 4 tutoriais navegáveis, cada um mão-na-massa (passos executáveis)
- [ ] Mesh remota sem claim de E2E; nuance de "Delivered" presente
- [ ] Daemon tutorial é só *how*; *why* linka pra `/why`
- [ ] `pnpm lint && pnpm build` OK

---

### Wave D — Doc → Referência (site) · refactor

**Despachar pro pane `Site`.** Refactor de `src/app/docs/page.tsx` (1273 linhas).

- **Encolher pra ponteiro** as seções tutorial-flavored: Quick start, What it does,
  Install, Using /remote-pi, Pairing, Quick actions, Agent network (deeper look),
  Daemon mode walkthrough → cada uma vira 1 parágrafo + "→ See the X tutorial".
- **Manter como referência**: The relay (self-host), Protocol & Security, Command
  reference, Configuration files, Troubleshooting, Links.
- Resultado: doc deixa de duplicar os tutoriais e cai de ~1273 linhas pra uma
  referência enxuta.

**DoD Wave D**:
- [ ] Seções de aprendizado reduzidas a parágrafo + ponteiro pro tutorial
- [ ] Referência preservada (relay/protocol/commands/config/troubleshooting/links)
- [ ] Zero walkthrough duplicado entre Docs e Tutoriais
- [ ] `pnpm lint && pnpm build` OK

---

### Wave E — Acender a aba "No Pi yet" com o curl real (site) · gated na Wave 0

**Despachar pro pane `Site`** depois que a Wave 0 fechar **e o smoke-test passar**.

- Rota estática serve **`pi-extension/install.sh` como fonte única** (copy/symlink
  no build — não duplicar conteúdo) sob o domínio canônico (`/install.sh`).
- **Gate**: só acende a aba "No Pi yet" **após o smoke-test em ambiente limpo**
  (macOS limpo + container Ubuntu) passar — recomendação da Wave 0.
- A aba **"No Pi yet"** sai de "Coming soon" e passa a mostrar o **curl real**. A
  aba "Already have Pi" segue inalterada.

**DoD Wave E**:
- [x] Smoke-test Linux limpo passou (v5 verde, idempotente) — macOS pendente ↓
- [x] `install.sh` servido em `/install.sh` via `public/install.sh` (cópia commitada byte-idêntica) + `scripts/sync-install-sh.mjs` no build (DRY no monorepo, no-op no Docker)
- [x] Aba "No Pi yet" mostra o curl real (`curlReady` default `true`)
- [x] Aba "Already have Pi" segue funcionando (sem regressão)
- [x] `pnpm lint && pnpm build` OK (15 rotas)
- [ ] **Re-publicar a imagem Docker** (`./push-docker.sh`) — a imagem atual foi buildada SEM `public/install.sh` → `/install.sh` 404 até republicar — **manual**
- [ ] macOS limpo (launchd) verificado manualmente (container cobriu só Linux) — **manual**
- [ ] **remote-pi republicado** contra `@earendil@0.78` (senão `pi install npm:remote-pi` puxa o SDK deprecated transitivo) — **manual/release**

---

## DoD consolidado

- [ ] Wave 0 — curl installer entregue, mas **smoke-test achou bug** (plugin `dist` ausente em clean install, exit 1); fix reaberto no Extension. Wave E bloqueada
- [x] Wave 0c — migração SDK `@mariozechner`→`@earendil-works@^0.78` (drop-in, **zero breaking**; `pnpm test` 426/426; install.sh + CLAUDE.md) — Extension. ⚠️ **republish do remote-pi pendente** (release)
- [x] Wave A — home de-bloat (hero novo, install em abas, daemon teaser, 1 CTA) — Site, `pnpm build` OK
- [x] Wave B — página `/why` (decisão + comparação auto-focada OpenClaw/Hermes Agent) — Site
- [x] Wave C — seção Tutoriais com os 4 tutoriais (Getting Started, Mesh local, Mesh remota, Daemon) — Site
- [x] Wave D — Doc reduzida a Referência (~900 linhas) + ponteiros; hero linka `/why` — Site
- [x] Wave C-extra — tutorial EXTRA `remote-pi claude` (Claude na mesh) — Site
- [x] Wave E (código) — aba "No Pi yet" acesa, `install.sh` servido via `public/` + sync. ⚠️ requer **re-publish da imagem Docker** + smoke macOS + republish npm (manual)
- [ ] Memory atualizada: `project_pre_publish_cycle` (27-D revisado) e nota da
      virada de posicionamento mesh→remote-control

### Wave C-extra — Tutorial EXTRA: Claude na mesh (`remote-pi claude`)

**Origem**: o pi-extension ganhou `remote-pi claude` — wrapper que põe o Claude Code
na mesh local UDS + relay como **peer nomeado**, ao lado do Pi. **Ainda não aparece
no App** (é agente-a-agente, dirigido pelo terminal). Vira tutorial **EXTRA**
(avançado), separado da trilha 1–4.

**Rota**: `src/app/tutorials/claude-mesh/page.tsx`; no índice, sob grupo **"Extras"**.

**Lastro** (scout pi-extension 2026-05-31 — citar com precisão):
- `remote-pi claude [cwd]` (`src/index.ts:_cmdClaudeCli`) — 1º run pede `agent_name`;
  registra o MCP em escopo local (`claude mcp add … -s local`, grava em
  `~/.claude.json`); faz deploy da skill em `~/.claude/skills/agent-network/SKILL.md`;
  spawna o Claude com `--dangerously-load-development-channels server:remote-pi-mesh`
  (push) + `--dangerously-skip-permissions` (auto-aprova tools).
- **MCP** (`src/mcp/mesh_server.ts`, stdio): 3 tools — `list_peers` (locais +
  `<pc>:<peer>`), `agent_send {to, body, re?}` (ACK received|busy|denied|timeout),
  `get_messages` (drena inbox).
- **Skill** `agent-network`: get_messages toda turn, inspeção de ACK (não é
  fire-and-forget), reply com `re`, broadcast fire-and-forget.
- **Channels**: na chegada de msg o server emite `notifications/claude/channel` → com
  dev-channels on, **acorda** o Claude; senão, polling de `get_messages`.
- **cwd-lock**: um agente por cwd (Pi **ou** Claude).
- **Por que não no App**: o app fala só com o relay e vê só o Pi que o pareou; não
  enxerga peers UDS locais (Claude). Surfacing de mesh no app = trabalho futuro.

**Restrições**: EN; sem E2E; Callout **warning** pros `--dangerously-*`; selo
**EXTRA / terminal-only (sem App ainda)** visível. Reusa Callout/DocsSection/Pager.

**DoD**:
- [x] Rota `/tutorials/claude-mesh` no ar; índice com grupo "Extras"
- [x] Explica `remote-pi claude` + os 3 injetados (MCP/tools, skill, channels) com precisão
- [x] Callout warning pros `--dangerously-*`; selo EXTRA/terminal-only visível
- [x] Sem E2E; `pnpm lint && pnpm build` OK (15 rotas)

## Próximos planos

- **i18n PT-BR** dos tutoriais/doc, se vier demanda (Plano 22 é EN-only).
- **Wrappers de harness** (Plano 27 Wave B): tutorial "Pi como gateway de um
  agente não-Pi (OpenClow/Hermes)" quando o wrapper de Claude Code/OpenCode
  existir — é o conteúdo avançado que saiu do hero hoje.
- **Tutoriais de receita** (casos de uso: revisar PR do celular, rodar testes
  remotos) conforme a seção amadurece.
