# Plan 70 — Revoke 缺少 `bye(peer_stop)` 生命周期通知

> 状态：待处理
>
> 优先级：P2
>
> 创建日期：2026-09-02
>
> 类型：已验证的产品生命周期缺口

## 1. 摘要

Remote Pi 当前执行 Owner revoke 时，能够正确撤销访问权限和 Relay ACL，但不会在解除 Owner binding 前向被撤销 Owner 发送 Protocol v2 `bye` 帧。被撤销 Owner 最终可以收到 `endpoint_ended`，并且后续 route 会被 Relay 拒绝；缺少的是主动、明确的 `bye(reason="peer_stop")` 生命周期通知。

这不是当前 E2E Docker 环境的缺陷，也不是已确认的访问控制漏洞。它是 Extension 在 revoke 场景下没有完成优雅断开通知的产品协议缺口。

## 2. 当前行为

`/remote-pi revoke <shortid>` 当前执行顺序为：

1. 从本地 `peers.json` 删除 Owner；
2. 调用 `detachOwner`，关闭对应的 Owner binding；
3. 调用 `updateEndpoint`，把新的授权 Owner 列表同步到 Relay；
4. Relay 向相关订阅方发送 `endpoint_ended` 或后续状态变化；
5. 被撤销 Owner 的后续 session route 不再获得响应。

相关实现：

- [`pi-extension/src/daemon/commands.ts`](../pi-extension/src/daemon/commands.ts) 的 `revoke`：删除 peer、detach binding 并更新 endpoint；
- [`pi-extension/src/index.ts`](../pi-extension/src/index.ts) 的 `detachOwner`：直接 detach channel 并从 active owner 集合移除；
- [`pi-extension/src/index.ts`](../pi-extension/src/index.ts) 的 `closeRelay`：stop、shutdown 和 session replacement 会发送 `bye`，但 revoke 不经过该路径。

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

## 5. 验证证据

在固定 Docker Relay-only E2E 环境中已验证：

- revoke 后被撤销 Owner 收到 `endpoint_ended`；
- 被撤销 Owner 的后续 `ping` 不会收到 `pong`；
- 存活 Owner 在 revoke 后仍可收到 `pong`；
- revoke 后未观察到被撤销 Owner 的 `bye(reason="peer_stop")`，验证输出为：

```text
finding revoke_peer_stop=expected_known_failure
```

复现入口：

```sh
./docker/e2e/scripts/up.sh
./docker/e2e/scripts/verify.sh
./docker/e2e/scripts/stop.sh
```

上述验证只记录该缺口，不将其作为 ACL 隔离失败，也不修改本计划之外的产品行为。

## 6. 修复验收标准

修复本缺口时至少应满足：

- revoke 对当前 active binding 发送一次 `bye(reason="peer_stop")`；
- `bye` 在 detach binding 前发送，确保帧仍可到达被撤销 Owner；
- `bye` 携带当前有效的 `session_id` 和 `history_generation`；
- revoke 后继续拒绝该 Owner 的 session route；
- 未被撤销 Owner 的 session、发现和 route 不受影响；
- 无 active binding 或 Owner 已离线时，revoke 仍成功完成 ACL 更新，不因通知失败阻塞撤销；
- pairing、stop、shutdown、session replacement 的既有 bye reason 和顺序不回归；
- 增加自动化测试，覆盖通知顺序、目标 Owner 隔离、撤销后 route 拒绝和离线 revoke。

## 7. 范围与关联

本文件只记录产品缺口，不包含本轮修复实现或排期承诺。固定 Docker 验收基础设施及其已知失败标记见 [`docker/e2e/README.md`](../docker/e2e/README.md)。

本缺口在以下提交的验收中被确认：

- `63293a3 test(e2e): 新增可复用的 Relay 协议隔离环境`

关联产品决策和 Protocol v2 生命周期定义：

- [`plan/69-remove-agent-mesh-and-rework-daemon.md`](69-remove-agent-mesh-and-rework-daemon.md)
- [`PROTOCOL.md`](../PROTOCOL.md)
