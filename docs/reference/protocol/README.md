# Remote Pi — Protocol & Security

本文描述 Remote Pi 当前生产协议、身份模型和安全边界。Protocol v2 是 Relay、Pi Extension 与 Browser/PWA 的唯一受支持协议；没有 v1 fallback、旧 room 路由、Agent Mesh、Pi-to-Pi 转发、membership storage 或旧本地数据迁移。

跨端 strict schema 真源：

- [`docs/reference/protocol/protocol-v2.md`](protocol-v2.md)
- [`docs/reference/protocol/pairing.md`](pairing.md)
- [`docs/reference/protocol/fixtures/v2/manifest.json`](fixtures/v2/manifest.json)

[历史文档索引](../legacy-plans.md)收录已迁移的旧方案与协议快照，只用于审计过去决策，不是当前协议真源。

## 1. 系统边界

```text
Browser/PWA Owner ── WebSocket/TLS ── Relay ── WebSocket/TLS ── Pi Extension endpoint
                                                                    │
                                                               Pi runtime/session
```

- **Browser/PWA** 保存 Owner identity、每台电脑的 pairing、endpoint metadata 和 timeline。
- **Relay** 验证连接身份，在内存中维护 endpoint registry 与当前 ACL，并转发 opaque `ct`。
- **Pi Extension** 保存 Host identity 与本机 Owner ACL，提供 pairing、Protocol v2 session channel 和 daemon runtime signals。
- **Daemon supervisor** 管理显式注册的 Pi child，不属于 Relay，也不接受 Cron 绕过生命周期门禁。

Endpoint 之间不能发现或互发消息。一个 Owner 可以独立配对多台电脑，并在同一 PWA 中选择各设备的多个 endpoint。

## 2. 身份与生命周期

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ session_id + history_generation
```

| 字段 | 含义 | 生命周期 |
|---|---|---|
| `owner_id` | PWA Owner 的 canonical Ed25519 公钥 | 当前浏览器 identity 存在期间稳定 |
| `device_id` | Host 电脑的 canonical Ed25519 公钥 | 当前 Host identity 存在期间稳定 |
| `endpoint_id` | 一个可路由 Pi 入口的 opaque UUID | daemon 跨 child 重启稳定；interactive Pi 每个进程生成 |
| `runtime_instance_id` | endpoint 当前 OS 进程实例 UUID | 每次 spawn 生成 |
| `session_id` | Pi SessionManager 会话 | `/new`、恢复或分支替换时可变化 |
| `history_generation` | 当前权威时间线代次 | session/branch 变化时更新 |
| `channel_id` | Owner 进入 endpoint 后的临时响应通道 | 当前实时 binding |

`cwd`、名称、PID、model、thinking 和 working 都是 metadata，不是身份。同一 cwd 可以有多个 endpoint。`/new` 不创建新 endpoint 或 runtime，只更新 session/generation。

持久 timeline key 是：

```text
device_id + endpoint_id + session_id + history_generation
```

`runtime_instance_id` 只用于实时 stale gate，不进入持久 timeline key。Remote Pi 当前不提供历史 Pi session 列表、远程 resume 或历史会话切换。

## 3. Relay outer protocol

所有连接先发送 role-aware `hello`，再完成 Ed25519 challenge-response。Host hello 包含 device、endpoint、runtime、metadata 和 `authorized_owner_ids`；Owner hello 只包含 Owner 公钥。认证身份必须等于 hello 中的 canonical 公钥。

业务 outer frame：

```jsonc
{
  "type": "route",
  "purpose": "pairing | session",
  "device_id": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "target_owner_id": "<Host→Owner 必填>",
  "source_owner_id": "<Relay 注入到 Owner→Host>",
  "ct": "<opaque string>"
}
```

方向规则：

- Owner→Host 禁止携带 `target_owner_id` 或 `source_owner_id`；Relay 鉴权后注入可信 `source_owner_id`。
- Host→Owner 必须携带 `target_owner_id`，禁止携带 `source_owner_id`。
- `purpose=pairing` 仅允许 `pair_request/pair_ok/pair_error`。
- 其他 Protocol v2 frame 只能使用 `purpose=session`，并且必须命中 Host 当前 ACL。
- Relay 不解析、解码、记录或持久化 `ct`。
- 相同 `(device_id, endpoint_id)` 只有一个权威 runtime；新 runtime 原子接管后，旧连接和迟到 route 都 stale。

Owner 使用 `subscribe_endpoints` 订阅已配对 device。Relay 以 `endpoints`、`endpoint_announced`、`endpoint_updated`、`endpoint_ended` 返回当前可见 endpoint。Host 用 `endpoint_update` 更新 metadata 与 `authorized_owner_ids`。

## 4. Pairing 与撤销

QR：

```text
remotepi://pair?t=<token>&epk=<device_id>&n=<display_name>&ep=<endpoint_id>&rt=<runtime_instance_id>
```

`ep` 和 `rt` 必填。未配对 Owner 不依赖 ACL 受限的 endpoint discovery，而是直接向 QR 指定的 endpoint/runtime 发送 `purpose=pairing` route。Relay 注入的 `source_owner_id` 是 Extension 唯一可信的待配对 Owner 身份。

Pairing token 是短期、单次使用 token。成功后 Extension：

1. 将 Owner 写入本机 `~/.pi/remote/peers.json`；
2. 发送 `endpoint_update.authorized_owner_ids`；
3. 返回 `pair_ok`；
4. PWA 保存 device-scoped pairing，再订阅该 device 的 endpoint。

每台电脑独立 pairing 和 revoke。撤销一个 device 上的 Owner 后，Extension 删除本地 ACL、关闭对应 binding、更新 Relay ACL；其他电脑上的 pairing 不受影响。没有跨设备 membership 传播。

完整规则见 [pairing contract](pairing.md)。

## 5. Protocol v2 inner frames

所有 inner frame 都是 strict JSON object，必须携带：

```json
{ "protocol_version": 2, "type": "..." }
```

缺少版本、未知版本、未知字段、错误方向、错误 route purpose 或 ready 前发送业务 frame 都 fail closed。配对后，PWA 必须先发送 `session_hello`；收到 `session_ready` 后才能发送 ready-only 业务 frame。

主要边界：

- 单 frame JSON UTF-8 最大 `2 MiB`；单 history chunk 最大 `512 KiB`。
- 单 fragment 解码后最大 `50 KiB`；未完成逻辑窗口最大 `32 MiB`。
- ID 最大 256 字符；普通字符串最大 `1 MiB`；数组最大 4096 项。
- `TimelineEvent` 同时用于实时正式事件与历史事件。
- `timeline_partial` 只用于实时可变状态，不进入 marker、SessionManager 或 IndexedDB。
- `runtime_instance_id` 只参与实时 route stale gate；timeline 由 session/generation 定位。

PWA→Extension frame 包括 pairing、session hello/sync、prompt、queue、cancel、typed actions、model/thinking、ping 和 Extension UI response。Extension→PWA frame 包括 pairing result、session ready、timeline/history、queue state、typed action result、model list、pong、reset、protocol error、Extension UI request 和 bye。精确字段及错误码以 strict contract/fixtures 为准。

### Timeline 与图片

- 正式 user event 满足 `event_id === message_id`。
- tool 的 `complete/error/interrupted` 状态互斥。
- image 的 inline `data` 与 `omitted=true` 互斥。
- 图片作为受尺寸限制的 Base64 inline block 进入 Protocol v2 frame；没有独立对象存储或 binary upload channel。
- PWA-owned follow-up queue 位于 Pi Extension 进程内存；Relay 不提供 offline queue，进程重启会丢失未发送 queue state。

### Typed actions

PWA 只调用冻结的 typed action：`session_new`、`session_compact`、`model_set`、`thinking_set`、`list_models` 和 `cancel`。它不是任意 slash-command 执行器。Action response 只确认 dispatch；正式可见结果继续通过 timeline/session frame 同步。

## 6. Daemon lifecycle contract

Daemon registry v2 位于 `~/.pi/remote/daemons.json`。每条记录包含稳定 UUID `endpoint_id`、canonical cwd、名称、`desired_state` 和创建时间。旧或错误 schema 会报错，不会静默覆盖。

状态维度互相独立：

| 维度 | 示例 |
|---|---|
| registration | `registered | missing` |
| desired | `running | stopped` |
| process | `absent | spawning | running | exited` |
| runtime | `pending | ready | failed` |
| relay | `disconnected | reconnecting | connected` |
| health | `stopped | starting | healthy | degraded | failed | blocked` |

健康不能由 PID 或 child 存活推导。Runtime ready 必须同时满足：

1. Pi RPC `get_state` 成功；
2. Extension 发出结构化 `runtime-ready`；
3. `control_protocol_version == 2`；
4. Extension 上报 endpoint/runtime 与 supervisor 注入值一致。

Supervisor 不导入私有 Pi SDK，也不在 child 外重复执行 resource discovery。实际宿主 `pi --mode rpc` 启动后负责 settings、package、resource discovery 与 diagnostics；Supervisor 消费 RPC `get_state` 和 Extension 的结构化 `runtime-ready`，不解析 stderr 推断状态。readiness 超时且 RPC 已 ready、Extension 仍未报告时进入 `extension_not_ready` blocked；身份、协议、Extension readiness 和 runtime identity 的确定性错误同样进入 `blocked`。不能将这一流程描述成“在 spawn 前发现所有 Extension 问题并阻止 child 启动”。运行细节见 [daemon 指南](../../../pi-extension/docs/daemon.md)。

Relay 断线只使 endpoint `degraded/reconnecting`；Extension 后台重连，不通过重启 Pi 修复网络。Transient process/runtime failure 使用有限 restart budget。

`start/stop` 持久化 `desired_state`；Supervisor 只恢复 `desired_state=running`。不存在的 cwd 会被运行期 reconcile 注销。`unregister_cwd`/`daemon remove-cwd` 是幂等删除入口。

Cron 不拥有 daemon 生命周期。它只能在 `desired=running`、runtime ready 且 health 允许时发送，否则记录 skip；没有 `wake`、`wake_and_send` 或 `--wake`。

## 7. 存储与隐私

### Pi Extension / Host

- Host Ed25519 key 优先存入平台 keyring。
- Headless/degraded fallback 是 `~/.pi/remote/identity.json`，目录权限 `0700`、文件权限 `0600`。
- 如果已有 pairing 但原 identity 不可读，Extension 不得静默生成新 identity；应进入确定性 blocked failure。
- `peers.json` 保存当前设备的 Owner public key、显示名和 paired time。
- `daemons.json`、Cron registry/log 和 Pi session 文件属于本机状态。

### Browser/PWA

IndexedDB 保存 Owner private identity、device pairing、endpoint metadata 和 timeline。清理浏览器站点数据会删除 Owner identity 和本地 timeline，需要重新 pairing。PWA 不持久化 runtime presence，runtime 只来自当前 Relay session。

### Relay

Relay 当前没有数据库或持久 volume。Registry、连接、ACL 和 subscription 全在内存中；Relay 重启后 Host/Owner 自动重连并重建状态。Relay 不保存 pairing history、endpoint inventory、message queue 或 traffic payload。

## 8. Trust model

### 已提供的保护

- TLS 保护浏览器、Relay 与 Host 之间的传输。
- Ed25519 challenge-response 证明连接持有对应 Owner/Host private key。
- Relay 根据连接角色、endpoint/runtime 和 Host ACL 强制 route 方向。
- Owner→Host 的 `source_owner_id` 由 Relay 注入，Owner 不能自报可信 sender。
- Runtime takeover 与 strict endpoint/runtime gate 阻止旧进程污染新 runtime。
- Pairing token 单次使用，且 pairing route 不能承载 session frame。
- Host/Owner private key 不进入 route metadata、日志或 QR；QR 只含 Host public key 与短期 token。

### 不提供的保护

- 当前没有应用层端到端加密。`ct` 是 Base64 编码的 Protocol v2 JSON，不是 ciphertext。
- 正常实现不会解析 `ct`，但控制 Relay executable 或 TLS endpoint 的运营方有能力观察流量。敏感工作应 self-host Relay。
- Relay 可观察连接 IP、public identifiers、endpoint/runtime metadata、timing 和 transport sizes。
- 获得浏览器 profile/IndexedDB、Host keyring/file identity 或进程权限的攻击者可能冒充对应身份。
- root、进程注入、已解锁用户会话和被攻陷的终端不在防护范围内。
- Relay 是实时路由可用性的单点；其宕机不会停止本地 Pi，但会中断远程控制。

## 9. Failure behavior

| 故障 | 行为 |
|---|---|
| Relay 断线 | Extension/PWA 后台重连；daemon 保持运行，health 为 degraded |
| Relay 重启 | 内存 registry 清空；连接重建后 Host 重新 announce，Owner 重新 subscribe |
| Daemon child 重启 | endpoint ID 保持，runtime ID 更新；旧 route 被拒绝。interactive Pi 的新进程则生成新 endpoint |
| QR runtime 已 stale | Pairing route 被拒绝；用户生成/扫描新 QR |
| Owner 未授权 session route | Relay 拒绝转发，不泄露 endpoint snapshot |
| 宿主 Extension 加载或 diagnostics 出错 | 由实际 Pi 宿主诊断；Supervisor 不能据 PID 判定 ready。RPC ready 但 Extension 未报告时进入 `extension_not_ready` blocked |
| RPC ready 但 Extension 未 ready | Readiness timeout/blocked，不能报告健康 running |
| Relay 断线但 Pi runtime ready | health degraded，不消耗 process restart budget |
| Daemon cwd 删除 | Supervisor reconcile 停止并注销 entry |
| Cron 命中 stopped/blocked/not-ready daemon | 记录 skip，不启动 daemon |

## 10. 参考实现与报告

- Relay：[`relay/src/`](../../../relay/src/)
- Pi Extension：[`pi-extension/src/`](../../../pi-extension/src/)
- Browser/PWA：[`pwa/src/`](../../../pwa/src/)
- Daemon 运维：[`pi-extension/docs/daemon.md`](../../../pi-extension/docs/daemon.md)

安全问题请通过仓库维护者公布的私密渠道报告；若当前没有私密渠道，创建 issue 时不要附带 secret、private key、token、Cookie 或可利用 payload。
