> **历史归档。** 原始路径：`plan/07-revoke-and-multi-session.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../reference/protocol/README.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# 07 — Revoke + multi-session (+ relay deploy)  ·  ✅ ENCERRADO

> **Status: ENCERRADO** (2026-06-05). Número sobrecarregado — carregou **três**
> intenções em conversas diferentes; nenhuma precisa de plano novo. Lápide pra
> preencher o gap de numeração e explicar.

## Os três significados que "07" acumulou

| Intenção | Origem do rótulo | Veredito |
|---|---|---|
| **Revoke de pareamento** | plan/05:505 (`07-revoke-and-multi-session`) | ✅ **ENTREGUE** pelo plano **08** |
| **1 Mac, várias sessões** | plan/05:505 | ✅ **ENTREGUE** pelo plano **17 (rooms)** — ver lápide `docs/plans/completed/20260606-one-mac-many-sessions.md` |
| **Relay deploy + throttle/jitter/rate-limit env** | plan/12:215, plan/13:182, plan/14:250 + memória `project_relay_throttle_env_future` | ⛔ **NÃO FAREMOS por agora** (decisão do usuário 2026-06-05) |

## Detalhe das duas entregues

- **Revoke** — `/remote-pi revoke <shortid>` + tab completion
  (`pi-extension/src/index.ts:1732`); multi-device concorrente
  (`_activePeers: Map`); propagação cross-side implícita (lado revogado limpa
  storage; o outro detecta via `error{unknown_peer}` do relay na próxima
  reconexão — plano 08 Q5, sem tipo `revoke_pair` no protocolo). App: swipe-to-
  revoke em Settings. **Funcional ponta a ponta, relay incluído.**
- **Multi-session** — modelo de **rooms** (plano 17): 1 cwd = 1 room; app agrupa
  rooms por peer (1 tile por (peer, room)). Detalhe completo na lápide da 15.

## A casca descartada (relay throttle/deploy)

Hospedar o relay em produção com **env vars de throttle/jitter/rate-limit** (pra
aguentar abuso / viabilizar múltiplas instâncias) era a leitura "viva" de 07 em
12/13/14. **Decidido não fazer por agora** — o relay roda de boa pro uso atual;
só reabrir se o relay público virar gargalo (aí é discussão explícita nova, não
necessariamente número 07). A memória `project_relay_throttle_env_future` foi
atualizada com essa decisão.

## Veredito

Nada a fazer. Não reabrir como plano. Os ponteiros antigos a "plano 07" em
05/12/13/14 caem aqui e se explicam.
