# Plan 71 — 配对持久化与 `pair_ok` 缺少事务一致性

> 状态：待处理
>
> 优先级：P2
>
> 创建日期：2026-09-04
>
> 类型：代码审查确认的配对事务一致性缺口

## 1. 摘要

Remote Pi 当前处理有效 `pair_request` 时，会先消费一次性 QR token，再持久化 Owner、同步 Relay ACL，最后发送 `pair_ok`。这些步骤跨越内存状态、文件存储、Relay 控制帧和 Owner 路由，但没有共同的提交边界，也没有针对丢失成功响应的幂等恢复语义。

如果 Relay 在 Owner 持久化期间断开，或用户同时执行 stop，可能出现 Host 已保存并最终授权 Owner，但 PWA 没有收到 `pair_ok`、因而没有保存 pairing record 的不一致状态。同一个 QR token 已被消费，不能直接重试；用户只能生成新 QR 后重新配对。

本缺口独立于 `/remote-pi pair` 等待首次 Relay 连接的竞态。首次连接、取消和后台重连正确收口，并不能保证一个已经开始执行的 `handlePairRequest()` 在异步持久化期间保持当前 Relay、binding 和 runtime 权威性。

## 2. 当前行为

当前 [`handlePairRequest()`](../pi-extension/src/index.ts) 按以下顺序执行：

1. 为 Relay 注入的 `source_owner_id` 创建 Owner binding；
2. 调用 `qrSession.consumeToken(frame.token)`，立即把 token 标记为已消费；
3. 调用 `addPeer()`，把 Owner 写入 `peers.json`；
4. 调用 `updateEndpoint()`，尝试发送包含新 `authorized_owner_ids` 的 `endpoint_update`；
5. 通过最初创建的 binding 发送 `pair_ok`。

相关边界：

- [`QRSession`](../pi-extension/src/pairing/qr.ts) 只有 `未消费 / 已消费` 状态，没有 reservation、commit、rollback 或请求归属；
- [`addPeer()`](../pi-extension/src/pairing/owner_storage.ts) 通过串行 mutation lane 写文件，同一 Owner 的重新配对会覆盖原记录，但调用方不能把该次写入与 Relay lifecycle 绑定；
- [`updateEndpoint()`](../pi-extension/src/index.ts) 在 Relay 不可用时直接返回，并吞掉发送异常，调用方无法区分“ACL 已同步”和“等待重连恢复”；
- [`V2PeerChannel.sendV2()`](../pi-extension/src/transport/peer_channel.ts) 不返回发送结果，并吞掉 Relay 已关闭时的异常；
- `handlePairRequest()` 在 `addPeer()` 和 `updateEndpoint()` 的 `await` 之后，没有重新校验 Relay client、Owner binding、endpoint runtime 或 pairing attempt 是否仍为当前权威对象。

正常连接下，现有真实 Relay/PWA E2E 已证明配对可以完成。本文件记录的是中断窗口，不把正常路径的成功当作该窗口已经被覆盖。

## 3. 可复现竞态窗口

核心时序如下：

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

相邻竞态也必须纳入后续设计：

- `addPeer()` 或 ACL 同步失败时，token 已经不可重用；
- 配对处理中生成新 QR，旧操作仍可能迟到完成；
- 同一 Owner 的新 pairing attempt 已替换 binding 后，旧操作仍持有旧 binding；
- Relay 或 Pi runtime 被替换后，旧操作不得向新生命周期提交授权或成功结果；
- `pair_ok` 已提交给 socket但 Owner 未收到时，单纯回滚 token 或 peer 仍不能解决“成功响应丢失”的确认歧义。

## 4. 影响与安全边界

### 4.1 用户与状态一致性影响

- Host 和 PWA 对“是否已经配对”可能产生不同结论；
- PWA 可能显示配对失败或超时，而 Host 已保存 Owner；
- 用户必须生成新 QR 并重新配对，原请求无法用同一 token恢复；
- peers 文件、Relay ACL 和 PWA IndexedDB 的状态可能在重连前后短暂或持续不一致。

### 4.2 当前没有证据表明的影响

本问题不是已证实的身份验证绕过：

- Owner 身份仍来自 Relay 认证并注入的 canonical `source_owner_id`；
- 未持有对应 Owner 私钥的第三方不会因该竞态获得授权；
- token single-use 仍能阻止其他请求再次消费同一 token；
- Relay 的 endpoint/runtime 和 session route 校验仍然存在。

风险在于一个已通过 token 校验的 Owner 可能在没有收到成功确认时被 Host 持久化和授权，而不是未认证身份绕过 token 获得权限。

## 5. 期望不变量

后续修复应明确并满足以下不变量：

1. 每个 pairing attempt 绑定到确定的 token、Owner、request ID、Relay client、endpoint 和 runtime；
2. 在每个异步边界后，旧 Relay、旧 runtime、旧 binding 或已被新请求取代的 attempt 不得继续提交；
3. token 不能在没有归属信息的情况下从“已消费”退回“可供任意 Owner 使用”；
4. Host 授权记录、Relay ACL 和 PWA 可确认的配对结果必须具有明确的提交或恢复路径；
5. 成功响应丢失后，同一 Owner 对同一请求的安全重试应得到幂等结果，而不是只能看到无上下文的 `token_consumed`；
6. 回滚旧 attempt 时不得删除或覆盖同一 Owner 的更新配对，也不得撤销其他并发操作写入的授权；
7. 新 QR 替换旧 token、Relay 重连和 runtime takeover 都必须使迟到操作 fail closed；
8. 正常单次配对、token 过期、未知 token 和不同 Owner 竞争同一 token 的既有安全语义不得回归。

## 6. 候选修复方向

本文件不冻结实现。后续设计至少应比较以下方向，并处理“提交成功但响应丢失”无法仅靠本地回滚解决的问题。

### 6.1 Token reservation / commit

把 token 状态扩展为类似：

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

现有 `conditionalRemovePeer()` 已提供按 Owner slot provenance 防止陈旧删除的机制，可作为候选复用点；但它只处理删除，不能直接恢复被重新配对覆盖的旧记录，也不能单独解决成功响应丢失。

### 6.4 幂等完成与结果重放

为 `(owner_id, token/request_id)` 保存有界、短期的完成结果。若授权已提交但 `pair_ok` 丢失，同一 Owner 的重试可以安全重放相同 `pair_ok`，而不是返回 `token_consumed`。

需要明确：

- 幂等键和保留时长；
- Pi 进程重启后的行为；
- 新 QR/runtime 取代旧操作时是否仍允许重放；
- 如何避免不同 Owner 利用已提交 token；
- PWA 是重试原 request，还是发起带稳定 attempt ID 的新请求。

### 6.5 可观察的 ACL/发送结果

配对路径需要比通用 best-effort 更新更强的结果语义。候选方式包括：

- 让 ACL 更新返回“已发送 / 等待重连 / 已失去权威”的明确结果；
- 让 pairing route 发送至少报告本地 socket 是否仍可写；
- 如协议要求确认 Owner 实际收到成功结果，则增加应用层 acknowledgement，而不能把 `send()` 未抛错当作端到端确认。

任何 acknowledgement 方案仍需幂等重试，以覆盖 acknowledgement 自身丢失。

## 7. 修复验收标准

自动化测试至少覆盖：

- token reservation 后、`addPeer()` 完成前断开 Relay；
- `addPeer()` 已写入但 ACL 尚未同步时 stop；
- ACL 已更新但 `pair_ok` 发送前断开；
- `pair_ok` 本地发送后 Owner 未收到并重试；
- 旧 attempt 迟到完成时已有新 QR、新 binding 或新 runtime；
- 同一 Owner 重新配对不会被旧 attempt 的补偿删除或覆盖；
- 不同 Owner 并发竞争同一 token 时只有一个可以取得 reservation；
- 持久化失败、token 过期、token unknown 和 token consumed 的错误码保持可解释；
- 正常配对仍按 `peer → ACL → pair_ok` 完成，PWA 保存 device record并可建立 session。

验证层级至少包括：

1. `QRSession` / pairing operation 状态机单元测试；
2. Owner storage provenance、恢复和并发 mutation 测试；
3. Extension 集成测试，用受控 deferred 精确暂停 `addPeer()` 与 ACL 更新；
4. 真实 Relay E2E，在配对关键窗口主动断开 Relay或 stop Host，并验证重试与最终 ACL；
5. 真实 PWA E2E，确认 IndexedDB pairing record、Host peers 和 Relay 可见性最终一致。

完成后必须通过受影响测试、`cd pi-extension && pnpm verify` 和 `git diff --check`。如果协议字段或 PWA 重试行为发生变化，还应同步协议 fixtures、PWA 测试和相应构建验证。

## 8. 非目标

本缺口不用于：

- 重新设计 Ed25519 身份、QR 编码或 Relay route trust model；
- 把 Relay 变成 pairing 数据库或长期事务协调器；
- 修改 token 默认 TTL；
- 兼容旧 QR、旧协议或缺失 endpoint/runtime 的 route；
- 顺带处理 revoke 缺少 `bye(peer_stop)` 的独立生命周期问题；
- 宣称网络环境中可以实现无重试、无 acknowledgement 的 exactly-once 消息送达。

## 9. 范围与关联

本文件只记录已确认的缺口、设计约束和验收边界，不表示已经排期或实现。

当前直接相关实现：

- [`pi-extension/src/index.ts`](../pi-extension/src/index.ts)：`handlePairRequest()`、`updateEndpoint()`、Relay/binding 生命周期；
- [`pi-extension/src/pairing/qr.ts`](../pi-extension/src/pairing/qr.ts)：一次性 token 状态；
- [`pi-extension/src/pairing/owner_storage.ts`](../pi-extension/src/pairing/owner_storage.ts)：Owner 持久化、mutation lane 与 provenance；
- [`pi-extension/src/transport/peer_channel.ts`](../pi-extension/src/transport/peer_channel.ts)：pairing route 发送语义；
- [`docs/reference/protocol/pairing.md`](../docs/reference/protocol/pairing.md)：当前 Protocol v2 配对契约。

现行协议文档继续描述当前正常流程。本缺口修复形成稳定契约后，再把最终选定的 reservation、重试、提交和错误语义同步到协议真源；在此之前，不把候选方案写成已经支持的行为。
