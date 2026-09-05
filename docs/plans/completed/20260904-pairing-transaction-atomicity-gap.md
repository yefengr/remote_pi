> 历史边界：本文件记录已修复的配对事务缺口，不作为当前执行或项目状态真源；当前配对契约以 [pairing protocol](../../reference/protocol/pairing.md) 为准，当前状态见 [ROADMAP](../../ROADMAP.md)。

# Plan 71 — 配对持久化与 `pair_ok` 缺少事务一致性

> 状态：已完成（当前进程内恢复范围）
>
> 优先级：P2
>
> 创建日期：2026-09-04
>
> 完成日期：2026-09-05
>
> 类型：已修复的配对事务一致性缺口

## 1. 摘要

Remote Pi 当前处理有效 `pair_request` 时，已建立当前进程内的 pairing attempt：token 先按 Owner/request reservation，随后持久化 Owner、同步当前 Relay ACL，记录并发送 `pair_ok`。这些步骤仍跨越内存状态、文件存储、Relay 控制帧和 Owner 路由，但现在具有明确的 attempt 归属、生命周期复核、条件补偿和同请求结果重放路径。

如果 Relay 在 Owner 持久化期间断开，或用户同时执行 stop，旧 attempt 会失去当前 Relay/binding 权威，不再向新生命周期提交；已经写入的 Owner 记录按 provenance 条件回滚，或由当前 peers.json 在重连时重新宣布。若 ACL 已提交而 `pair_ok` 丢失，同一 Owner 使用相同 token 与 request ID 重试时可以重放已记录的 `pair_ok`。

本修复独立于 `/remote-pi pair` 等待首次 Relay 连接的竞态，并专门收口已经开始执行的 `PairingCoordinator` 在异步持久化期间的 Relay、binding 和 runtime 权威性。

## 2. 当前行为

当前 [`PairingCoordinator`](../../../pi-extension/src/runtime/pairing_coordinator.ts) 按以下顺序执行：

1. 以 `(owner_id, pair_request.id)` 查找正在进行的 attempt；
2. 为当前 token 建立 Owner/request reservation；
3. 创建 Owner binding 和 pairing attempt；
4. 调用 `addPeer()` 写入 `peers.json` 并取得 provenance；
5. 在异步边界后检查当前 Relay、endpoint/runtime、binding 和 reservation；
6. 发送当前 Relay 的 `endpoint_update`，发送失败则不确认配对；
7. 缓存并 commit 当前 request 的 `pair_ok`，再通过当前 binding 尽力发送；
8. 同一 Owner/request 的后续请求可重放 committed `pair_ok`。

当前边界与范围：

- [`QRSession`](../../../pi-extension/src/pairing/qr.ts) 提供进程内 reservation、release、commit 和完成结果重放；
- [`addPeer()`](../../../pi-extension/src/pairing/owner_storage.ts) 返回 `PeerWriteReceipt`，`conditionalRollbackPeer()` 只在 slot provenance 仍匹配时补偿；
- [`updateEndpoint()`](../../../pi-extension/src/index.ts) 返回当前 Relay 是否接受了 ACL 控制帧；
- [`V2PeerChannel.sendV2()`](../../../pi-extension/src/transport/peer_channel.ts) 返回本地发送是否成功；
- PWA 对已发送 request 在 Relay close/超时时最多自动重试一次，并复用原 token 与 request ID；
- pairing completion 仍是进程内状态，Pi 进程重启后不承诺恢复原 request。

## 3. 修复前的可复现竞态窗口

修复前的核心时序如下：

```text
Owner/PWA                 Pi Extension                         Relay
    | pair_request              |                                |
    |-------------------------->|                                |
    |                            | consume token                  |
    |                            | await addPeer()                 |
    |                            |<-- Relay close / explicit stop -|
    |                            | detach Owner binding            |
    |                            | addPeer() resolves              |
    |                            | updateEndpoint() no-op/fails    |
    |                            | sendV2(pair_ok) is dropped       |
    |       no pair_ok           |                                |
```

可能结果：

- token 已处于 `consumed`；
- Owner 记录已经写入 `peers.json`；
- Relay 重连后，Host hello 或后续 endpoint update 可能把该 Owner 纳入 ACL；
- PWA 因没有收到 `pair_ok`，不会保存 device-scoped pairing record；
- 同一 QR 重试得到 `token_consumed`；
- 使用新 QR 重新配对通常可以恢复，因为 `addPeer()` 对同一 Owner 是覆盖式写入，但这要求用户重新发起配对，且不等于原事务一致完成。

本批次同时处理的相邻竞态包括：

- `addPeer()` 或 ACL 同步失败时，token 已经不可重用；
- 配对处理中生成新 QR，旧操作仍可能迟到完成；
- 同一 Owner 的新 pairing attempt 已替换 binding 后，旧操作仍持有旧 binding；
- Relay 或 Pi runtime 被替换后，旧操作不得向新生命周期提交授权或成功结果；
- `pair_ok` 已提交给 socket但 Owner 未收到时，单纯回滚 token 或 peer 仍不能解决“成功响应丢失”的确认歧义。

## 4. 修复前的影响与安全边界

### 4.1 用户与状态一致性影响

- Host 和 PWA 对“是否已经配对”可能产生不同结论；
- PWA 可能显示配对失败或超时，而 Host 已保存 Owner；
- 用户必须生成新 QR 并重新配对，原请求无法用同一 token恢复；
- peers 文件、Relay ACL 和 PWA IndexedDB 的状态可能在重连前后短暂或持续不一致。

### 4.2 当前没有证据表明的影响

本问题不是已证实的身份验证绕过：

- Owner 身份仍来自 Relay 认证并注入的 canonical `source_owner_id`；
- 未持有对应 Owner 私钥的第三方不会因该竞态获得授权；
- token reservation 仍阻止其他 Owner 或 request 复用同一 token；
- Relay 的 endpoint/runtime 和 session route 校验仍然存在。

风险在于一个已通过 token 校验的 Owner 可能在没有收到成功确认时被 Host 持久化和授权，而不是未认证身份绕过 token 获得权限。

## 5. 修复不变量

本批次实现满足以下不变量：

1. 每个 pairing attempt 绑定到确定的 token、Owner、request ID、Relay client、endpoint 和 runtime；
2. 在每个异步边界后，旧 Relay、旧 runtime、旧 binding 或已被新请求取代的 attempt 不得继续提交；
3. token 不能在没有归属信息的情况下从“已消费”退回“可供任意 Owner 使用”；
4. Host 授权记录、Relay ACL 和 PWA 可确认的配对结果必须具有明确的提交或恢复路径；
5. 成功响应丢失后，同一 Owner 对同一请求的安全重试应得到幂等结果，而不是只能看到无上下文的 `token_consumed`；
6. 回滚旧 attempt 时不得删除或覆盖同一 Owner 的更新配对，也不得撤销其他并发操作写入的授权；
7. 新 QR 替换旧 token、Relay 重连和 runtime takeover 都必须使迟到操作 fail closed；
8. 正常单次配对、token 过期、未知 token 和不同 Owner 竞争同一 token 的既有安全语义不得回归。

## 6. 已实施的修复

本批次采用进程内 reservation、生命周期复核、带 provenance 的条件补偿和同请求结果重放。它不把 Relay 改造成事务协调器，也不宣称网络层 exactly-once。

### 6.1 Token reservation / commit

token 状态已扩展为：

```text
active
→ reserved(owner_id, request_id, lifecycle)
→ committed(owner_id, request_id, result)
```

reservation 只能由同一 Owner 和 request 恢复或提交；旧 lifecycle、不同 Owner 或不同 request 必须失败。只有安全回滚时才能从 reserved 恢复，不能把已绑定 Owner 的 token 重新开放给任意请求。

### 6.2 Pairing attempt generation 与生命周期复核

为处理中的 pairing 建立独立 generation/operation identity。在 `addPeer()`、ACL 更新及发送成功结果前分别检查：

- Relay client 仍为当前连接；
- endpoint/runtime 未被替换；
- active binding 仍属于该 Owner 和 attempt；
- token reservation 仍归当前 request 所有。

生命周期复核可以阻止迟到提交，但本身不能恢复已经完成的文件写入。

### 6.3 带 provenance 的存储提交与补偿

扩展 Owner 存储 API，使 pairing 写入返回该次 mutation 的 provenance 和写入前快照。需要补偿时，只能在 provenance 仍匹配且没有更新 re-pair 的情况下恢复旧记录或移除本次新增记录。

新增的 `conditionalRollbackPeer()` 复用 Owner slot provenance，并通过写入 receipt 恢复被本次 re-pair 覆盖的旧记录或移除本次新增记录；陈旧 receipt 不能修改后续写入。

### 6.4 幂等完成与结果重放

为 `(owner_id, token/request_id)` 保存有界、短期的完成结果。若授权已提交但 `pair_ok` 丢失，同一 Owner 的重试可以安全重放相同 `pair_ok`，而不是返回 `token_consumed`。

幂等键为同一 token 下的 `(owner_id, request_id)`，保留至当前 QR 被替换、清除或进程结束。新 QR/runtime 会使旧的未提交 attempt 失效；不同 Owner 或不同 request 不能取得 reservation。PWA 最多自动重试一次原 request，并复用同一 request ID。

### 6.5 可观察的 ACL/发送结果

ACL 更新和 pairing route 现在都会报告本地 socket 是否接受发送。ACL 发送失败时不 commit token；`pair_ok` 本地发送失败时保留 committed completion，供同请求重放。该结果不等同于 Owner 端 acknowledgement，因此仍不宣称端到端 exactly-once。

## 7. 修复验收结果

已覆盖的自动化测试：

- token reservation 后、`addPeer()` 完成前断开 Relay；
- `addPeer()` 已写入但 ACL 尚未同步时 stop；
- ACL 已更新但 `pair_ok` 发送前断开；
- `pair_ok` 本地发送后 Owner 未收到并重试；
- 旧 attempt 迟到完成时已有新 QR、新 binding 或新 runtime；
- 同一 Owner 重新配对不会被旧 attempt 的补偿删除或覆盖；
- 不同 Owner 并发竞争同一 token 时只有一个可以取得 reservation；
- committed 结果在 token TTL 后仍可由同一 Owner/request 重放，未提交 reservation 仍会过期；
- ACL 同步统一串行化，较旧快照不会晚于较新的授权集合发送；
- 持久化失败、token 过期、token unknown 和 token consumed 的错误码保持可解释；
- 正常配对仍按 `peer → ACL → pair_ok` 完成，PWA 保存 device record并可建立 session。

验证层级包括：

1. `QRSession` 状态机和 Owner storage provenance 单元测试；
2. Extension 集成测试，用受控 deferred 精确暂停 `addPeer()`，覆盖 Relay close、新 QR 和竞争 Owner；
3. PWA 浏览器 hook 测试，覆盖 Relay close/timeout 同请求重试与迟到响应隔离；
4. Extension 全量 verify、PWA 全量测试和 production build。

已通过 `cd pi-extension && pnpm verify`（391 passed、3 skipped）、PWA 全量测试（125 项 Node、103 项 browser）、PWA production build、目标源码 ESLint、现有 Docker E2E 和 `git diff --check`。Docker E2E 证明真实 Relay/Extension 的正常配对、双 Owner session、revoke、`bye(peer_stop)` 与 runtime 重启路径未回归；本批次未增加配对关键窗口的主动中断 E2E。PWA 全仓 `pnpm lint` 仍被既有生成文件 `public/sw.js` 的 ESLint `no-this-alias` 错误阻塞，未修改该生成文件。

## 8. 非目标

本缺口不用于：

- 重新设计 Ed25519 身份、QR 编码或 Relay route trust model；
- 把 Relay 变成 pairing 数据库或长期事务协调器；
- 修改 token 默认 TTL；
- 兼容旧 QR、旧协议或缺失 endpoint/runtime 的 route；
- 顺带处理 revoke 缺少 `bye(peer_stop)` 的独立生命周期问题；
- 宣称网络环境中可以实现无重试、无 acknowledgement 的 exactly-once 消息送达。

## 9. 范围与关联

本文件记录当前进程内恢复范围的实现与验证结果。跨 Pi 进程重启的持久化 pairing receipt 仍不在本批次范围内。

当前直接相关实现：

- [`pi-extension/src/runtime/pairing_coordinator.ts`](../../../pi-extension/src/runtime/pairing_coordinator.ts)：pairing attempt、提交、补偿和结果重放；
- [`pi-extension/src/index.ts`](../../../pi-extension/src/index.ts)：依赖注入、`updateEndpoint()` 和 Relay/binding 生命周期；
- [`pi-extension/src/pairing/qr.ts`](../../../pi-extension/src/pairing/qr.ts)：token reservation/commit 状态；
- [`pi-extension/src/pairing/owner_storage.ts`](../../../pi-extension/src/pairing/owner_storage.ts)：Owner 持久化、mutation lane 与 provenance；
- [`pi-extension/src/transport/peer_channel.ts`](../../../pi-extension/src/transport/peer_channel.ts)：pairing route 发送语义；
- [`docs/reference/protocol/pairing.md`](../../reference/protocol/pairing.md)：当前 Protocol v2 配对契约。

当前配对 reservation、同请求重试和进程内结果重放契约已同步至 [`docs/reference/protocol/pairing.md`](../../reference/protocol/pairing.md)。跨进程重启恢复仍未承诺。
