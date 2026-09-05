> **历史归档。** 原始路径：`plan/10-polish-and-bugs.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# Plano 10 — Polish + Bugs (pós-MVP)

## Contexto

MVP funcional desde plano 06; plano 08 entregou multi-pairing + Home +
revoke. Usuário começou a usar e reportou 1 bug + 2 melhorias imediatas
+ 1 ideia futura.

Este plano agrupa itens **não-bloqueantes pro produto rodar** mas
importantes pra qualidade percebida. Cada item é independente — não há
ordem obrigatória, podem ser despachados conforme bandwidth.

---

## Itens

### 🐛 Bug 10.1 — Estado "aguardando" não limpa após resposta terminar

**Sintoma reportado**: ChatPage mostra indicador de "aguardando" mesmo
depois que o agente já terminou de responder. Suspeita do usuário: pode
acontecer especificamente quando a resposta final termina com `?`. Pode
ser coincidência — investigação aberta.

**Hipóteses**:

1. **Pi-ext não envia `agent_done`** em algum caminho (ex: agente termina via tool sem texto final, ou via `agent_end` event que não fora wired)
2. **App não consome `agent_done`** ou mantém flag `awaiting=true` num estado terminal específico
3. **Race condition**: último `agent_chunk` chega *após* `agent_done` (improvável em WS ordenado, mas vale checar)
4. **Edge case visual**: typing-indicator não desliga em texto que termina com `?` por algum match de regex/parser
5. **`_currentTurnId` no pi-ext não é limpo** em algum branch (ex: erro no meio do streaming)

**Investigação (despachar Pi-ext OU App primeiro)**:

- [ ] Pi-ext: revisar `pi.on("agent_end", ...)` e `pi.on("message_update", ...)` em `src/index.ts` (linhas ~336–356). Confirmar que `agent_done` é sempre enviado **exatamente uma vez** por turno; logar `_currentTurnId` antes e depois.
- [ ] Pi-ext: adicionar log temporário no envio de `agent_done` com payload do `in_reply_to`.
- [ ] App: revisar `ChatViewModel` — encontrar a flag/state que controla "aguardando" e mapear quando ela vira `false`. Logar transições.
- [ ] User repro: provocar a condição (resposta terminando com `?`) e capturar logs dos 2 lados — se `agent_done` chega no app mas a flag persiste, é bug do app; se não chega, é bug do pi-ext.

**Aceite**: após investigação, fix em um lado OU outro; teste unit cobrindo o cenário (mock de `agent_done` chegando após N chunks); QA manual confirma que indicador some.

---

### ✨ Feature 10.2 — Remover sistema de approval (postergado; revogado 2026-05-19)

**Decisão revisada em 2026-05-19**: ao invés de adicionar "allow all",
**remover o sistema de approval do pi-extension** completamente. Razão:
o SDK do Pi não tem campo nativo `requiresApproval` por tool — nosso
`tool_gate.ts` decidia hardcoded (Bash/Edit/Write pedem; Read/Glob/Grep
não), forçando approval em **todas** as tools custom de packages. Isso
era ruído pro usuário e não escalava.

**Sem mecanismo nativo no SDK pra inventar convenção própria agora.**
Adia decisão; quando o ecossistema de extensions Pi amadurecer (ou
descobrirmos como packages podem declarar tools sensíveis), revisitar
em plano futuro (`plan/11-permissions.md` ou similar).

**Escopo desta mudança**:
- **Pi-ext**: removida toda lógica de approval. Tool calls executam direto.
  - Remove handler `pi.on("tool_call", ...)` que abre prompt
  - Remove `_pendingApprovals` + `decide()` + `AUTO_APPROVE_TOOLS`
  - Remove `tool_gate.ts` (órfão)
  - Remove case `approve_tool` em `routeClientMessage`
  - Mantém envio de `tool_result` pra transparência (app vê o que rodou)
  - Não envia mais `tool_request` (sem approval pra pedir)
- **App**: **NÃO mexer.** Tipos `ToolRequest`/`ApproveTool` permanecem em `protocol.dart` + approval card permanece em `chat_page.dart` — infra pronta pra quando voltarmos a ativar permissions. Como pi-ext não envia mais `tool_request`, esses códigos ficam dormentes (sem warning).
- **Relay**: zero mudança.
- **Contracts**: `protocol.md` mantém os tipos (forward-compat); adicionar nota explicando que pi-ext atualmente não usa.

**Tarefas**:

- [x] Pi-ext: remover handler `pi.on("tool_call", ...)`, `_pendingApprovals`, case `approve_tool`, `tool_gate.ts`, suítes de teste relacionadas
- [x] Pi-ext: mantém `pi.on("tool_execution_end", ...)` (continua enviando `tool_result`)
- [x] Atualizar `contracts/protocol.md` com nota: "tool_request/approve_tool definidos mas não emitidos pelo pi-ext do MVP — reservados pra plano futuro de permissions"
- [x] Atualizar `pi-extension/CLAUDE.md` removendo referências a approval gate se houver (não havia)
- [x] Atualizar `../../adr/20260518-closed-decisions.md` registrando reversão

**Decisões abertas (fechar antes de despachar)**:

- **Q10.2.a — Escopo do "allow all"**: a) toda a sessão Pi até desconectar; b) por turno (até `agent_done`); c) timer (5min); d) toggle persistente no Pi
- **Q10.2.b — Onde mora a flag**: a) no app (não envia approve_tool, dispara `decision=allow` automaticamente); b) no pi-ext (gate vira no-op temporariamente); c) ambos (default flag local + opção pro Pi pular gate). **Recomendação: (b)** — flag fica no pi-ext, app só manda comando `set_auto_approve`. Centraliza segurança no lado que vê os comandos.
- **Q10.2.c — UI**: a) toggle nas Settings do app; b) botão na AppBar do chat ("⚡ auto-approve ON/OFF"); c) checkbox no próprio approval card ("aprovar todos desta sessão"). **Recomendação: (b)** + (c) combinados — botão sempre visível na AppBar, e o próprio card de approval tem um checkbox shortcut.

**Mudança no protocolo** (se Q10.2.b = pi-ext):

```jsonc
// novo client→server
{ "type": "set_auto_approve", "id": "...", "enabled": true,
  "scope": "session" | "turn" }

// novo server→client (resposta + broadcast pra outros devices se múltiplos)
{ "type": "auto_approve_state", "enabled": true, "scope": "session" }
```

Após `enabled: true`, pi-ext pula o `await pendingApproval` em
`tool_call` event — chama `return` direto (allow). Mantém `tool_request`
+ `tool_result` no canal pra transparência visual (user vê o que rolou
mesmo sem precisar aprovar).

**Tarefas**:

- [ ] Fechar Q10.2.a/b/c com user
- [ ] Atualizar `contracts/protocol.md` com 2 novos types
- [ ] Adicionar fixtures: `set_auto_approve.jsonl`, `auto_approve_state.jsonl`
- [ ] Pi-ext: flag `_autoApprove` + handler no `routeClientMessage` + skip no `pi.on("tool_call")`
- [ ] App: toggle na AppBar do chat + checkbox no approval card + state no `ChatViewModel`
- [ ] Reset do flag quando peer desconecta ou troca de sessão (anti-pegadinha)
- [ ] Testes de cobertura: flag liga/desliga, escopo session vs turn, persistência cross-mensagem

---

### ✨ Feature 10.3 — Apelido local + display de sessão

**Pedido reportado (refinado 2026-05-20)**: app precisa de um **apelido
local** pra não se perder entre peers. Sem apelido, mostra `sessionName`
do Pi (cwd, hoje). Com apelido, mostra apelido em destaque + sessionName
embaixo como contexto. Dois lugares de display: Home (SessionTile) e
Chat (AppBar).

**Modelo**:
- `PeerRecord.nickname: String?` — campo novo, opcional, local-only no Keychain
- Display rule:
  - `nickname == null` → title = `sessionName`, sem subtitle de nome (mesmo de hoje)
  - `nickname != null` → title = `nickname`, subtitle compacto = `sessionName`
- Pi nunca sabe do apelido (privacidade + simplicidade)

**UX de edição**: ícone de lápis no PeerListItem da Settings → bottom-sheet
com TextField. Vazio salva como `null` (volta ao default).

**Tarefas**:

- [ ] Adicionar `nickname: String?` em `PeerRecord` (storage retrocompat — campo opcional, peers antigos ficam com null)
- [ ] `PairingStorage`: serialize/deserialize com fallback null
- [ ] `SettingsViewModel.setNickname(epk, String? nickname)` (substitui ou complementa o `rename` atual)
- [ ] `PeerListItem` (Settings): ícone de lápis no trailing → abre bottom-sheet
- [ ] Bottom-sheet `nickname_editor.dart`: TextField + Salvar/Cancelar/Remover apelido (se já tem). Validação: vazio = null; max 40 chars
- [ ] `SessionTile` (Home): mostrar `nickname ?? sessionName` como title; se nickname existe, sessionName aparece como subtitle pequeno
- [ ] `ChatPage` AppBar: mostrar `nickname ?? sessionName` como title; se nickname existe, sessionName como subtitle compacto
- [ ] Testes:
  - Storage: salva e recupera nickname null/preenchido
  - SettingsViewModel: setNickname atualiza state.peers
  - Widget: PeerListItem renderiza nickname quando existe; SessionTile renderiza fallback corretamente

**Custo estimado**: ~4h (storage + 1 widget novo + 2 lugares de display + testes).

---

### 🐛 Bug 10.5 — Input local do Pi não chega no app (dessincronização)

**Sintoma reportado**: quando user digita input direto no terminal do Pi
(em vez de enviar pelo celular), nada acontece no app — mensagem nunca
aparece e timeline fica fora de sincronia com o terminal.

**Diagnóstico**:
- App → `user_message` → `routeClientMessage` chama `_pi.sendUserMessage(text)` → SDK dispara `InputEvent{source: "extension"}` → seta `_currentTurnId` → streaming flui pro app ✓
- Terminal Pi → `InputEvent{source: "interactive"}` → **nenhum handler ouve esse evento** → `_currentTurnId` continua `null` → `pi.on("message_update", ...)` e `pi.on("agent_end", ...)` fazem early-return (`if (!_currentTurnId) return`) → app não vê nada

O SDK do Pi tem o evento exato: `pi.on("input", ...)` com `InputEvent.source: "interactive" | "rpc" | "extension"`.

**Solução**:

1. **Pi-ext**: handler `pi.on("input", event)`:
   - `source === "extension"`: ignora (já tratado via `routeClientMessage`)
   - `source === "interactive" | "rpc"`: gera `turnId = local_<uuid>`, seta `_currentTurnId`, envia inner `user_input{id: turnId, text: event.text}` pro app
2. **Novo tipo no protocolo**: `user_input` (server→client) — separado de `user_message` (que é client→server) pra direções não-ambíguas
3. **App** (`SessionRepository._onServerMessage`): branch `UserInput` adiciona `UserMsg(id, text)` à timeline e seta `streaming: StreamingMessage(inReplyTo: id)` — mesmo padrão de `sendMessage` local
4. **`contracts/protocol.md`**: adicionar `user_input` na tabela server→client + fixture `user_input.jsonl`

**Tarefas**:

- [x] Wave 0 (orquestrador): atualizar `contracts/protocol.md` + fixture
- [x] Pi-ext: `pi.on("input", ...)` + tipo `UserInput`
- [x] App: tipo `UserInput` em `protocol.dart` + handler em `SessionRepository`
- [x] Testes: pi-ext (60 ✓ incl. 4 novos) + app (85 ✓ incl. 4 novos)
- [x] QA manual confirmado pelo user

### ✨ Feature 10.6 — Mostrar tools sendo executadas (nível 1)

**Pedido reportado**: hoje app só mostra pergunta + resposta. Tools
(Bash, Edit, Read, etc) que o agente roda ficam invisíveis. User quer
ver os processos internos sendo executados.

**Achado importante (bug invisível)**: app **já tem infra de ToolEvent**
(`domain/session_state.dart`) com states `pending/completed/denied`. O
`_updateTool` em `SessionRepository` atualiza o ToolEvent existente
quando `tool_result` chega. **Mas** na 10.2 removemos a emissão de
`tool_request` junto com o gate de approval → tool_result chega no app
sem ter ToolEvent prévio → `_updateTool` faz `.map()` sem encontrar →
no-op silencioso → tool desaparece da UI.

**Fix simples** (nível 1, não confundir com approval):

Pi-ext volta a emitir `tool_request`, mas via evento `pi.on("tool_execution_start", ...)` em vez do antigo `tool_call` (que era o hook do gate). `tool_execution_start` é notificação pura — não bloqueia, não pede approval. Dispara quando tool VAI executar.

```typescript
pi.on("tool_execution_start", (event) => {
  if (!_peerChannel) return;
  _peerChannel.send({
    type: "tool_request",
    tool_call_id: event.toolCallId,
    tool: event.toolName,
    args: event.args as Record<string, unknown>,
  });
});
```

App: zero mudança funcional. **Adição defensiva**: `_updateTool` cria `ToolEvent` se não achar (fallback pra ordem invertida ou tool_request perdido). Já protege contra futuros bugs de ordering.

**Contratos**: zero mudança. `tool_request` já existe na spec do protocolo (estava dormente desde 10.2). Atualizar nota em `protocol.md` esclarecendo que tool_request voltou a ser emitido como notificação visual (não-bloqueante).

**Tarefas**:

- [x] Pi-ext: handler `pi.on("tool_execution_start", ...)` emitindo `tool_request` (63 tests ✓)
- [x] App: fallback defensivo no `_updateTool` pra criar `ToolEvent` se não achar (87 tests ✓)
- [x] Pi-ext: 3 testes novos (tool_execution_start → tool_request emitido)
- [x] App: 2 testes novos (`tool_result` órfão cria ToolEvent + regressão tool_request→tool_result)
- [x] Contracts: nota em `protocol.md` (tool_request voltou como notificação, não approval)
- [ ] QA manual: rodar pergunta que invoque Bash/Read/Grep → ver tools aparecerem na timeline com transição pending→completed

### 💡 Futuro 10.4 — Persistência de histórico local (read offline)

**Pedido reportado**: ideia pro futuro — quando entra em sessão, ela
inicia vazia (não há histórico). Duas direções possíveis:

**Direção A — Replicar sessão**: pi-ext envia "snapshot" do histórico
do Pi quando app conecta (toda a conversa anterior daquela sessão Pi).
Custo: depende do limite de 1 MiB do protocolo + sessões longas viram MB.
Beneficio: ver passado mesmo após app re-instalar.

**Direção B — Cache local incremental**: app salva localmente cada
`user_message` enviada + `agent_chunk`s recebidos. Quando reabre, mostra
histórico local mesmo offline. Beneficio: read offline; histórico
persiste no device.

**Híbrido (recomendação)**: B agora (simples, atende UX), A pro futuro
quando relay público existir + multi-device (plano 11+).

> **Não escopar agora.** Marcado como ideia pra avaliar depois do plano
> 07 (relay deploy). Pode virar plano 11.

---

## Definition of Done

- [x] Bug 10.1: investigação concluída, fix mergeado, QA manual confirma — race do `_flushTimer` resolvido em `session_repository.dart` (cancela timer + drena buffer no AgentDone)
- [x] Feature 10.2 (REVISADA): sistema de approval removido do pi-ext; app mantém infra dormante pra plano futuro
- [ ] Feature 10.3: rename + display + reload reactive
- [ ] Futuro 10.4: avaliar viabilidade após plano 07

---

## Próximos planos

- **`plan/07-relay-deploy.md`** — relay público + TLS + cert pinning
- **`plan/09-e2e-restore.md`** *(opcional)* — religar Noise XX
- **`plan/11-session-replay.md`** — escopar 10.4 quando virar prioridade
