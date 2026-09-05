> 历史边界：本文件记录已修复的 revoke 生命周期缺口，不作为当前执行或项目状态真源；当前协议以 [Protocol v2](../../reference/protocol/protocol-v2.md) 为准，当前状态见 [ROADMAP](../../ROADMAP.md)。

# Plan 70 — Revoke 缺少 `bye(peer_stop)` 生命周期通知

> 状态：已完成
>
> 优先级：P2
>
> 创建日期：2026-09-02
>
> 完成日期：2026-09-04
>
> 类型：已修复的产品生命周期缺口

## 1. 摘要

Remote Pi 过去执行 Owner revoke 时，能够正确撤销访问权限和 Relay ACL，但不会在解除 Owner binding 前向被撤销 Owner 发送 Protocol v2 `bye` 帧。该缺口现已修复：在线目标 Owner 会先收到 `bye(reason="peer_stop")`，随后 Extension 才解除其 binding 并同步 Relay ACL。

这不是 E2E Docker 环境缺陷，也不是已确认的访问控制漏洞。它是 Extension 在 revoke 场景下曾缺少优雅断开通知的产品协议缺口。

## 2. 修复前行为

修复前，`/remote-pi revoke <shortid>` 的执行顺序为：

1. 从本地 `peers.json` 删除 Owner；
2. 调用 `detachOwner`，关闭对应的 Owner binding；
3. 调用 `updateEndpoint`，把新的授权 Owner 列表同步到 Relay；
4. Relay 向相关订阅方发送 `endpoint_ended` 或后续状态变化；
5. 被撤销 Owner 的后续 session route 不再获得响应。

根因是 revoke 直接执行静默 `detachOwner`；全局 stop、shutdown 和 session replacement 已有各自的 `bye` 路径，但 revoke 没有定向通知单个 Owner 的关闭操作。

## 3. 期望行为

被撤销 Owner 的绑定应先收到一次针对当前 session 和 history generation 的终止通知：

```json
{
  "protocol_version": 2,
  "type": "bye",
  "session_id": "<current-session>",
  "history_generation": "<current-generation>",
  "reason": "peer_stop"
}
```

推荐的生命周期顺序为：

```text
bye(reason="peer_stop")
→ detach Owner binding
→ update Relay ACL
→ endpoint_ended / 后续 discovery 状态更新
```

通知应只发送给被撤销 Owner，不应影响其他仍然授权的 Owner。撤销完成后，Relay 仍必须拒绝被撤销 Owner 的后续 route。

## 4. 影响

当前安全边界仍然有效：

- Owner 会从本地授权记录中移除；
- Host 发往 Relay 的授权 Owner 列表会更新；
- 被撤销 Owner 后续 route 不会得到 `pong` 或其他 session 响应；
- 其他授权 Owner 仍可发现 endpoint 并正常通信。

缺少 `bye(peer_stop)` 会造成以下生命周期问题：

- 被撤销客户端只能通过 `endpoint_ended` 或通用连接状态推断原因；
- 依赖 `bye` 清理当前 session、取消 pending 请求或展示明确断开原因的客户端，无法使用统一终止语义；
- revoke 场景与显式 `/remote-pi stop`、shutdown 的终止通知行为不一致。

## 5. 实现与验证证据

实现采用定向 `closeOwner(ownerId, "peer_stop")` 路径：

1. 从目标 Owner binding 固定的 session identity 取得 `session_id`，从其 service 取得 `history_generation`，因此 session replacement 的 manager 切换窗口也不会产生 `"unknown"`；
2. 通过目标 channel best-effort 发送 `bye(reason="peer_stop")`；
3. 静默 detach 目标 binding；
4. revoke 命令继续调用 `updateEndpoint()` 同步移除该 Owner 后的 ACL。

普通 Relay disconnect、binding 替换和 pairing 失败仍使用静默 `detachOwner`；全局 stop、shutdown 与 session replacement 的既有通知路径不变。

2026-09-04 已通过：

- 聚焦测试：`cd pi-extension && pnpm exec vitest run src/daemon/commands.test.ts src/extension.test.ts`，2 个文件、27 项测试通过；
- Extension 全量验证：`cd pi-extension && pnpm verify`，typecheck、31 个测试文件（370 passed、3 skipped）和 build 通过；
- E2E 脚本语法检查：`node --check docker/e2e/runner.mjs` 通过；
- 固定 Docker Relay-only E2E：`./docker/e2e/scripts/verify.sh` 通过，其中包括：

```text
assert revoked_owner_rebound_after_new=true
assert revoke_peer_stop_bye=true
assert revoke_bye_before_endpoint_ended=true
assert revoked_route_rejected=true
assert survivor_ping_after_revoke=true
```

E2E 会在 session replacement 后先让目标 Owner 与存活 Owner 都重新建立当前 binding，再撤销在线目标 Owner；因此 `bye` 断言使用目标 Owner 最新 `session_ready` 返回的权威 `session_id` 和 `history_generation`。

## 6. 修复验收结果

- [x] revoke 对当前 active binding 发送一次 `bye(reason="peer_stop")`；
- [x] `bye` 在 detach binding 前发送；
- [x] `bye` 携带当前有效的 `session_id` 和 `history_generation`；
- [x] revoke 后继续拒绝该 Owner 的 session route；
- [x] 未被撤销 Owner 的 session 和 route 不受影响；
- [x] 无 active binding 或通知发送失败时仍完成本地删除和 ACL 更新；
- [x] pairing、stop、shutdown、session replacement 的既有生命周期路径不回归；
- [x] 自动化测试覆盖完整通知顺序、session replacement 窗口、目标 Owner 隔离、撤销后 route 拒绝、存活 Owner 和离线 revoke。

## 7. 范围与关联

固定 Docker 验收基础设施及当前断言见 [`docker/e2e/README.md`](../../../docker/e2e/README.md)。Plan 71 的 pairing 事务一致性缺口不在本次修复范围内，状态不变。

本缺口在以下提交的验收中被确认：

- `63293a3 test(e2e): 新增可复用的 Relay 协议隔离环境`

关联产品决策和 Protocol v2 生命周期定义：

- [Plan 69](20260829-remove-agent-mesh-and-rework-daemon.md)
- [`PROTOCOL.md`](../../reference/protocol/README.md)
