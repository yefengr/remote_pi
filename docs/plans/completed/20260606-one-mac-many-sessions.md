> **历史归档。** 原始路径：`plan/15-one-mac-many-sessions.md`。本文已退出当前执行入口；归档不等于所有条目已实现，正文为原始快照。 当前索引：[历史计划索引](../../reference/legacy-plans.md)；当前协议：[PROTOCOL.md](../../../PROTOCOL.md)；当前事项：[ROADMAP.md](../../ROADMAP.md)。

# 15 — Pareamento "1 por Mac, várias sessões"  ·  ✅ ABSORVIDO

> **Status: ABSORVIDO** pelo **plano 17 (rooms)** + **plano 08 (multi-pairing)**.
> Confirmado por scout app+extension em 2026-06-05. Este arquivo é uma **lápide**
> — preenche o gap de numeração; a 15 nunca precisou ser escrita como plano.

## O que era (adiado do plano 14, linhas 35 e 251)

"pi-ext anuncia `session_announced` ao subir nova sessão; app mantém lista de
sessões agrupadas por peer." Era visto como "mudança grande de modelo".

## Por que não precisou — o 17 (rooms) entregou isso

O plano **17 (rooms)** entregou exatamente a visão, incrementalmente, com a
semântica **"room"** no lugar de **"session"**:

- cada `cwd` = um room (`roomId = sha256(realpath(cwd))[:12]`,
  `pi-extension/src/session/cwd_lock.ts`);
- o pi-ext/relay **anuncia** o room via `room_announced` — o `session_announced`
  que a 15 imaginava;
- o app descobre via `subscribe_rooms`, agrupa rooms por peer e cria **1 tile por
  (peer, room)** — a "lista de sessões agrupadas por peer" do design
  (`app/lib/data/transport/connection_manager.dart`: `_roomsByPeer: Map<epk,
  List<RoomInfo>>`; `HomeViewModel`);
- **multi-pareamento** (plano 08) cobre o "N Macs" no mesmo app
  (`_activePeers: Map`, `PairingStorage.listPeers()`, switcher em Settings).

Modelo emergente (confirmado nos scouts): N Pis — ou daemons do **plano 26** — =
N rooms/peers; a **malha** (planos 19/25/34) faz os agentes do mesmo Mac se
enxergarem. A 15 ficou redundante.

## Resíduo (não é desta 15)

O único pedaço NÃO entregue é surfacear **múltiplos agentes da malha** dentro do
app (não rooms) — isso vive na **fase 3 do plano 38** + a UI da malha (19+), não
aqui.

## Veredito

Nada a fazer. Não reabrir como plano.
