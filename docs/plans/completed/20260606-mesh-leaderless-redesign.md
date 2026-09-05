> **历史归档。** 原始路径：`plan/35-mesh-leaderless-redesign.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# 35 — Malha leaderless (UDS-direto + POST HTTP)  ·  ⛔ DESCONTINUADO

> **Status: DESCONTINUADO** (decisão do usuário, 2026-06-05). Este arquivo é uma
> **lápide** — preenche o gap de numeração entre `plan/34` e `plan/36` pra
> `ls plan/` não confundir, e registra o que foi a 35 e por que morreu. Não é
> plano executável.

## O que era

Redesign da malha de agentes de **estrela** (broker UDS hospedado pelo líder via
bind-race + `broker_remote`, planos 19/25) pra **P2P direta sem líder**:

- **Local**: cada agente = servidor **HTTP-sobre-UDS** na própria pasta
  (`<cwd>/.pi/remote-pi/api.sock` / `socks/<roomId>.sock`); `cwd_lock` faz
  "socket da pasta = endereço do agente". Envio = connect → 200/500 → close.
- **Cross-PC**: `POST /send` no relay (síncrono, hold ≤10s, idempotente por `id`)
  + **WS receive-only** por agente (NAT impede POST no destino). Auth = assinatura
  por request; relay roteia pelo `envelope.to` assinado, nunca por header.
- **Confiança por máquina** (chave/Owner-key intacta); **pasta = rota, não
  identidade**. Sem chave por agente.

Decisões fechadas em **2026-06-02** (framing HTTP/1.1-UDS local; freshness ±20s;
`list_peers` cortado; deprecação faseada do frame `pi_envelope`; gate =
**denylist** em camadas PC-wide + override local). Atacava 5 dores: "Delivered ≠
peer vivo", roster fantasma, busy-gate bypass, MCP desconecta-e-não-volta,
version-skew do líder.

## Por que foi descontinuado

Decisão do usuário em 2026-06-05. A malha **broker/líder** dos planos 19/25,
endurecida pelo **plano 34** (busy-drop removido, presença passiva via
`list_peers` pull, broadcast O(N) preservado pra contagem do app), **permanece a
arquitetura corrente e mantida** — não há mais um sucessor "leaderless" no
roadmap.

Consequências:
- **Planos 19 / 25 NÃO são superseded.** Seguem vivos junto do 34. (A pendência
  antiga "marcar 19/25 SUPERSEDED" fica **anulada** — não marcar.)
- A identidade estruturada de peer (**plano 38**) assenta sobre o **broker**, que
  agora é o lar permanente — não um transporte de transição.

## Código órfão a decidir (não tratado por esta lápide)

A Wave 0 + 0b (malha local direta) chegou a ser **implementada, commitada e
pushada** na branch **`feat/mesh-35-wave0-local-inbox`** (existe local **e** em
`origin`; `main` intacta). Arquivos novos em `pi-extension/src/session/`:
`inbox_server.ts`, `send_client.ts`, `address.ts`, `mesh_message.ts`. 441 testes
verdes na branch; Wave A (relay `POST /send`) nunca iniciada.

> **Pendência aberta pro usuário**: decidir o destino da branch
> `feat/mesh-35-wave0-local-inbox` — **deletar** (local + origin) pra não virar
> zumbi, ou **arquivar** se algum pedaço (ex.: `address.ts`) for reaproveitável no
> 38. Não mexido aqui sem autorização explícita.

## Se um dia ressuscitar

Transporte leaderless é **ortogonal** à identidade estruturada (plano 38): os 4
eixos `pc·workspace·worktree·name` valeriam igual sobre UDS-direto. Reabrir como
discussão explícita, não silenciosamente — e reconciliar com o 38 já entregue.
