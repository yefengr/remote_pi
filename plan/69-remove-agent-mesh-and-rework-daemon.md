# Plan 69 — 移除 Agent Mesh 并重构 Daemon 生命周期

> 状态：已完成（自动化实现与验证通过；真实 Relay 链路验收待部署环境）
>
> 创建日期：2026-08-29
>
> 适用范围：`pi-extension/`、`relay/`、`site/`、Remote Pi 协议、daemon registry/supervisor，以及 worktree 删除联动。

## 1. 文档职责

本文是 Remote Pi 从“Pi + Agent Mesh + Relay + PWA”收敛为“Pi/Daemon + Relay + PWA”的实施真源，冻结本轮已经确认的产品边界、领域模型、失败语义和验收标准。

本文不记录一次性诊断日志，也不把旧实现描述成目标设计。实现阶段如发现项目事实与本文冲突，必须先回到本文修正契约，不得在代码中静默引入新的产品语义。

本轮实现已覆盖 Relay、Pi Extension、Site/PWA、daemon supervisor、共享 Protocol v2 contracts 与文档；最终验证命令和遗留风险在本文件末尾收口记录。

本计划显式取代或收缩以下既有方向：

| 既有计划 | 本计划后的状态 |
|---|---|
| [Plan 19 — Agent Network](19-agent-network.md) | Agent-to-agent 网络整体取消；本地 UDS broker、agent tools 和 skill 删除。 |
| [Plan 24 — Mesh Membership](24-mesh-membership.md) | 跨电脑 Owner membership、mesh storage、`/mesh` API 和 topology 删除；每台电脑单独配对。 |
| [Plan 25 — PC Mesh Bootstrap](25-pc-mesh-bootstrap.md) | 跨电脑 Pi-to-Pi 路由、ACK、broker remote 和 bridge 删除。 |
| [Plan 34 — Mesh Reliable Delivery](34-mesh-reliable-delivery-passive-presence.md) | 仅属于 agent mesh 的可靠投递与 presence 语义删除。 |
| [Plan 35 — Leaderless Mesh](35-mesh-leaderless-redesign.md) | 已废弃，继续仅作为历史记录。 |
| [Plan 38 — Structured Mesh Identity](38-mesh-structured-identity.md) | `(pc, cwd, name)` agent address 和 `#N` 冲突分配删除。 |
| [Plan 41 — Room per cwd/name](41-room-per-cwd-name.md) | `(cwd, name)` room 身份删除；改为显式 endpoint 身份。 |
| [Plan 51 — Cross-PC Mesh Routing](51-cross-pc-mesh-routing-hardening.md) | 跨 PC agent routing 整体删除。 |
| [Plan 17 — Rooms](17-rooms.md) | 多运行入口能力保留，但 `room` 术语、cwd 派生身份和旧协议被 endpoint 模型取代。 |
| [Plan 26 — Daemon Mode](26-daemon-mode.md) | supervisor 架构保留；registry、启动策略、扩展加载、状态和重试模型被本文重写。 |
| [Plan 39 — Daemon Cron](39-daemon-cron.md) | Cron 保留，但必须消费新的 desired state/readiness；删除 `wake` 绕过语义，不能自行启动 stopped/blocked daemon。 |

旧计划保留为历史证据，不在本次方案记录中逐份改写。后续实现和文档更新必须引用本文的新边界。

## 2. 背景与当前问题

### 2.1 Registry 将临时 worktree 变成永久 daemon

当前 daemon registry 位于 `~/.pi/remote/daemons.json`。注册项只保存 cwd 和可选名称；supervisor 启动时遍历全部记录并尝试启动，无 `desired_state`、禁用状态、来源或 worktree 生命周期信息：

- [`pi-extension/src/daemon/registry.ts`](../pi-extension/src/daemon/registry.ts)
- [`pi-extension/src/daemon/supervisor.ts`](../pi-extension/src/daemon/supervisor.ts)

普通 worktree 创建流程曾调用 `remote-pi create`，但 worktree 删除没有对应 teardown。结果是历史 worktree 即使不再使用或路径已不存在，仍留在全局 registry，并在登录或 supervisor 重启后被再次拉起。

### 2.2 `running` 只代表 child 尚未退出

当前 `DaemonState` 只有 `starting/running/stopped/crashed`。`RpcChild.spawn()` 创建 OS 子进程后立即进入 `running`，不等待以下条件：

- Pi RPC runtime ready；
- Remote Pi extension 加载成功；
- extension `session_start` 完成；
- Relay 鉴权和连接完成；
- daemon 能接收并确认请求。

相关实现：

- [`pi-extension/src/daemon/control_protocol.ts`](../pi-extension/src/daemon/control_protocol.ts)
- [`pi-extension/src/daemon/rpc_child.ts`](../pi-extension/src/daemon/rpc_child.ts)

因此“进程存在但 extension 失败、RPC 不可用或 Relay 未连接”仍可能显示为普通 `running`。当前 `daemon send` 也只确认数据写入 child stdin，不证明 Pi 已接受或处理。

### 2.3 Extension 存在双重加载路径

supervisor 当前通过 `-e <remote-pi/dist/index.js>` 显式加载全局 Remote Pi，同时 Pi settings 又可能自动发现已安装的 Remote Pi package。两个物理安装路径即使版本和内容相同，也可能被 Pi 视为两个 extension，导致同名 tool/command 冲突。

现有基于 `WeakSet<ExtensionAPI>` 的保护只能识别同一个 API 对象；两个 extension loader wrapper 不能可靠去重。extension diagnostic 又没有进入 supervisor readiness，最终表现为日志报冲突而 status 仍显示 `running` 或反复重启。

### 2.4 Agent Mesh、Room 与 Pi Session 被混合展示

当前系统同时存在三层概念：

```text
machine/peer key
  └─ room_id（由 cwd + mesh name 派生的 Relay 路由）
       └─ Pi session_id + history_generation
```

Agent mesh 又为同一 cwd/name 分配 `#2/#3`，导致 PWA room、mesh peer、daemon 和交互式 Pi 的身份相互耦合。`daemon status` 来自 supervisor child map，`remote-pi peers` 来自 mesh roster，两者无法可靠对应。

### 2.5 `/new` 替换 Pi Session，但不替换进程

Pi 的 `/new` 默认在同一个 OS 进程和 cwd 内替换 AgentSession：旧 session 被 shutdown，新 SessionManager 获得新的 `session_id` 和空上下文，extension 被重新绑定，PID 不变。旧 session 文件仍可在本地通过 `/resume` 使用。

因此远程路由入口不能直接等同于 Pi `session_id`。否则 `/new` 会迫使 Relay 路由、PWA 卡片和缓存主键同时变化。

## 3. 已确认的产品决策

1. **完整移除 agent mesh。** 不保留本机或跨电脑 Pi-to-Pi 通信。
2. **保留 PWA 多电脑、多运行会话。** 会话之间相互独立，不能互发 agent 消息。
3. **每台电脑单独配对。** 不保留跨电脑 Owner membership 自动传播。
4. **同一 cwd 允许多个并发运行入口。** 身份不再由 cwd/name 或 `#N` 决定。
5. **PWA 卡片代表运行入口，不代表历史 Pi 对话。** `/new` 在同一卡片内切换当前 Pi session。
6. **本次不提供 PWA 历史 session 列表或远程 `/resume`。**
7. **产品未上线，不迁移旧 room、旧 IndexedDB 数据或旧协议。** 禁止双读、双写和自动降级。
8. **普通 worktree 不自动注册 daemon。** daemon 必须显式启用。
9. **worktree 删除时自动停止并注销 daemon。** supervisor 同时防御性清理不存在的 cwd。
10. **daemon `start/stop` 持久化期望状态。** supervisor 只恢复期望运行的 daemon。
11. **Relay 断线是降级，不触发 Pi 重启。** extension 自行重连。
12. **daemon 加载完整 Pi extension 环境。** Pi settings 是 Remote Pi extension 的唯一加载来源；supervisor 不再传 Remote Pi `-e`。
13. **确定性启动错误进入 `blocked`。** 不无限自动重试。
14. **daemon 重启保持逻辑 endpoint，更新 runtime instance。**

## 4. 目标术语与身份模型

### 4.1 稳定术语

| 术语 | 含义 | 生命周期 |
|---|---|---|
| `device_id` | 一台运行 Remote Pi 的电脑身份；由现有机器密钥体系承载 | 跨进程、跨重启稳定 |
| `owner_id` | 一个已配对 PWA/Browser/iPhone Owner 身份 | 直到在该电脑上撤销 |
| `endpoint_id` | PWA 可选择并向其路由消息的逻辑 Pi 运行入口 | daemon 跨重启稳定；交互式 Pi 每次启动生成 |
| `runtime_instance_id` | endpoint 当前这一次 OS 进程实例 | 每次进程启动生成 |
| `session_id` | Pi SessionManager 的真实会话 ID | `/new`、`/resume`、`/fork`、`/clone` 时可能变化 |
| `history_generation` | 当前 session/branch 的权威时间线代次 | session 替换或 branch 变化时更新 |
| daemon registration | supervisor 持久管理某个 cwd 的配置记录 | 直到显式 remove 或 cwd 失效被清理 |
| `desired_state` | daemon 的持久期望状态：`running` 或 `stopped` | `start/stop` 修改 |

代码、协议和 UI 不再使用 `peer` 表示“另一个 agent”。底层密码学身份如仍需使用 public key，命名必须说明其角色是 `device` 或 `owner`，不能重新引入 agent mesh 语义。

### 4.2 身份层级

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ current session_id + history_generation
```

约束：

- `cwd`、名称、PID、模型和 thinking 都是可变 metadata，不是主键；
- daemon `endpoint_id` 从持久 daemon registration 获得，不随 child 重启变化；
- interactive endpoint 在 Pi 进程启动时生成一次，必须跨 extension reload 和 `/new` 保持不变；
- `runtime_instance_id` 在进程启动时生成一次，extension reload 和 `/new` 不改变；
- 新 daemon child 必须产生新的 `runtime_instance_id`；
- 同一 `(device_id, endpoint_id)` 同时只能有一个权威 host runtime；新实例接管时旧实例的延迟帧必须被拒绝；
- 同一 cwd 可以存在一个 daemon endpoint 和多个 interactive endpoint。

`endpoint_id`、`runtime_instance_id` 的具体编码格式在实施 Phase 0 冻结，但必须是不可从展示字段解析的 opaque ID。

## 5. 目标架构

```text
┌──────────────────────────────┐
│ PWA / Browser / iPhone       │
│ - 保存多台电脑的独立配对     │
│ - 发现并选择 endpoint        │
└──────────────┬───────────────┘
               │ TLS WebSocket
               ▼
┌──────────────────────────────┐
│ Relay                        │
│ - device/owner 鉴权          │
│ - endpoint discovery         │
│ - (device, endpoint) 路由    │
│ - 不解析 Protocol v2 inner   │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
 Interactive Pi      Supervisor
 endpoint            └─ Daemon Pi endpoint(s)
```

明确删除：

```text
Pi ↔ local UDS broker ↔ other Pi
Pi ↔ mesh bridge ↔ Relay ↔ other PC Pi
```

Relay endpoint discovery 不是 agent mesh。它只回答“当前已配对电脑上有哪些用户可进入的 Remote Pi 运行入口”，不允许 endpoint 互相发现或通信。

## 6. 移除与保留范围

| 能力 | 结果 |
|---|---|
| 本地 UDS broker | 删除 |
| 本机 Pi-to-Pi 通信 | 删除 |
| 跨电脑 Pi-to-Pi 通信 | 删除 |
| `list_peers` | 删除 |
| `agent_send` | 删除 |
| `agent_request` | 删除 |
| agent-network skill / MCP mesh server | 删除 |
| mesh address、`#N`、topology、siblings、bridge | 删除 |
| Relay `/mesh` API 与 mesh DB | 删除 |
| 跨电脑 Owner membership / SelfRevoke | 删除 |
| 每台电脑独立 pairing/revoke | 保留 |
| PWA 多电脑、多 endpoint | 保留 |
| Relay endpoint discovery/routing | 保留并重命名 |
| Interactive Pi 远程控制 | 保留 |
| Daemon + supervisor | 保留并重构 |
| Protocol v2 timeline、queue、model、thinking、extension UI | 保留 |
| Pi 本地 session 文件、`/new`、`/resume` | 保留 |
| PWA 历史 session 浏览、远程 `/resume` | 本次不提供 |

## 7. 配对与多电脑语义

- pairing 作用域是一台 `device_id`，不是某个 endpoint，也不是多电脑 mesh；
- 用户可以从该电脑上的任意可交互入口发起配对，成功后 Owner 可发现该电脑当前和后续 endpoint；
- PWA 要管理三台电脑，必须分别完成三次配对；
- 每台电脑独立保存允许的 Owner；撤销只影响该电脑；
- 不通过 Relay mesh store 把 Owner membership 自动复制到其他电脑；
- PWA 可以使用同一个本地 Owner 身份保存多台电脑的 pairing records；
- Owner/PWA 当前离线不影响 daemon 健康。

## 8. Relay Endpoint 协议

### 8.1 路由模型

Relay 的 host runtime registry 从 `(peer_id, room_id)` 收敛为：

```text
(device_id, endpoint_id)
  → { runtime_instance_id, metadata, live_connection }
```

Owner 连接与 host endpoint 连接必须在鉴权后具有明确角色，不能继续依赖同一个“peer/room”概念承载两类生命周期。

路由 frame 使用严格 tagged 形状：

```jsonc
{
  "type": "route",
  "purpose": "pairing | session",
  "device_id": "<device_id>",
  "endpoint_id": "<endpoint_id>",
  "runtime_instance_id": "<runtime_instance_id>",
  "target_owner_id": "<owner_id, host→owner 必填>",
  "source_owner_id": "<owner_id, Relay 注入到 Owner→Host>",
  "ct": "<opaque string>"
}
```

Owner 发出的 route 禁止携带 `target_owner_id` 或 `source_owner_id`；Relay 鉴权后只在转发给 Host 时注入可信 canonical `source_owner_id`。Host 发出的 route 必须携带 `target_owner_id` 且不得携带 `source_owner_id`。`purpose=pairing` 只允许用于 QR 配对请求，`purpose=session` 必须命中 Host 上报的 Owner ACL。Relay 不解析 `ct`。

配对 QR 使用 `remotepi://pair?t=<token>&epk=<device_id>&n=<display_name>&ep=<endpoint_id>&rt=<runtime_instance_id>`；未配对 Owner 直接用 QR 的 endpoint/runtime 发出 `purpose=pairing` route，不依赖 ACL 受限的 endpoint discovery；配对成功后再订阅 endpoint snapshot。

Endpoint metadata 至少包括：

```text
kind: daemon | interactive
name
cwd
pid
started_at
model?
thinking?
working
runtime_instance_id
```

敏感或无展示价值的环境信息不得进入 metadata。

### 8.2 Control frame 方向

旧 `subscribe_rooms`、`rooms`、`room_announced`、`room_ended`、`room_meta_update` 语义被 endpoint 版本一次性替换。目标能力包括：

- Owner 订阅某个已配对 device 的 endpoints；
- Relay 返回当前 endpoint snapshot；
- endpoint 上线、下线和 metadata 更新 push；
- Owner 发送的 route 指定目标 device/endpoint/runtime；
- Relay 向 Host 转发 Owner route 时注入可信 `source_owner_id`，向 Owner 转发 Host route 时保留 `target_owner_id`；
- Extension 发送的 inner payload 只广播给该 device 上已获授权且已进入该 endpoint 的 Owner channels；
- Relay 不解析 Protocol v2 inner payload。

具体字段名和 strict schema 在 Phase 0 冻结。由于产品未上线，不保留 `room_*` alias 或旧 envelope fallback。

### 8.3 接管与迟到消息

- 相同 `(device_id, endpoint_id)` 出现新的 `runtime_instance_id` 时，Relay 必须执行确定性接管或拒绝，不能让两个 host runtime 同时成为权威入口；
- PWA 的活动选择和实时 journal 同时校验 `endpoint_id` 与 `runtime_instance_id`；
- 旧实例的迟到帧、旧 channel response 和旧 working 状态不得污染新实例；
- daemon 重启后 endpoint 卡片保持，运行中临时状态重置；
- interactive Pi 重启产生新 endpoint，旧 endpoint 下线。

## 9. PWA 会话语义

PWA 一张卡片表示一个 endpoint。建议展示：

```text
设备名称
endpoint 名称
类型：Daemon / Interactive
cwd
PID
运行时长
模型 / thinking
状态：Healthy / Degraded / Working / Offline / Blocked
```

同名卡片通过类型、PID、启动时间和 endpoint 身份区分；不再使用 `#2/#3` 作为协议身份或持久名称。

PWA 分开维护三类作用域：

```text
endpoint card:       device_id + endpoint_id
live runtime:        device_id + endpoint_id + runtime_instance_id
persisted timeline:  device_id + endpoint_id + session_id + history_generation
```

`runtime_instance_id` 只用于拒绝过期实时状态，不进入持久正式时间线主键；否则 daemon 重启会错误切断仍属同一 Pi session 的历史。具体 IndexedDB 索引在 Phase 0 按查询需求冻结。

产品未上线，允许直接替换 schema 或重建本地数据库：

- 不迁移旧 `roomId`；
- 不保留旧 pairing/room/cache 兼容代码；
- 不实现双读双写；
- 测试 fixture 全部切换到 endpoint 模型。

## 10. Pi `/new` 与 Endpoint 生命周期

执行 `/new` 后：

```text
endpoint_id          不变
runtime_instance_id  不变
PID                  不变
cwd                  不变
session_id           更新
history_generation   更新
```

行为要求：

1. 旧 session 的进行中 turn 按 Pi 默认机制 settle/abort；
2. Extension 在旧 `session_shutdown` 中释放 session-scoped handler；
3. Relay 连接可以短暂重建，但新连接必须携带相同 endpoint/runtime identity；
4. 新 `session_start` 完成 Protocol v2 handshake；
5. PWA 保持同一 endpoint 卡片，清空当前活动时间线并同步新 session；
6. 旧 Pi session 只保留在本地 session storage，可在终端 `/resume`；
7. 本计划不为 PWA 增加历史 session 列表或远程恢复。

Endpoint/runtime identity 必须保存在 Pi 进程级生命周期中，不能依赖会在 extension reload 时重新求值的普通模块局部变量。

## 11. Daemon Registry 与期望状态

### 11.1 目标 schema

Registry 采用带版本的持久 schema，至少保存：

```json
{
  "version": 2,
  "daemons": [
    {
      "id": "<opaque-daemon-id>",
      "cwd": "/absolute/real/path",
      "name": "daemon-lifecycle-fix",
      "desired_state": "running",
      "created_at": 1788010000000
    }
  ]
}
```

约束：

- daemon ID 必须持久保存，不再依赖每次从 cwd 重新计算；
- cwd 注册时规范化为 realpath；
- cwd/name 变更不应静默改变 endpoint identity；
- registry 写入必须原子化，非法 schema 不得被当成空 registry 后静默覆盖；
- 本次不迁移旧 registry；实现可明确拒绝旧版本并提供一次性清理指引。

### 11.2 显式注册

普通 Git worktree 创建不调用 daemon registration。只有明确的 daemon enable/create 操作才：

1. 校验 cwd；
2. 预检 Pi 与 Remote Pi extension；
3. 创建 registration；
4. 设置 `desired_state=running`；
5. 请求 supervisor 启动；
6. 返回 daemon ID 和 readiness 结果。

具体 CLI 命名在 Phase 0 冻结；无论保留 `create` 还是改为 `daemon enable`，都必须表达“显式提升为常驻 daemon”，不能由 worktree setup 隐式触发。

### 11.3 持久 start/stop

```text
start <id>   → desired_state=running  → 启动或恢复 child
stop <id>    → desired_state=stopped  → 停止 child
restart <id> → desired_state 保持 running → 替换 child
remove <id>  → 停止 child → 删除 registration
```

Fleet/all 操作对选中 registration 逐项持久化，不允许只修改 supervisor 内存状态。

### 11.4 Supervisor 启动与运行期 reconcile

Supervisor 启动时：

1. 加载并验证 registry；
2. 对每条记录检查 cwd；
3. cwd 不存在则不 spawn，原子删除 stale entry 并记录结构化日志；
4. `desired_state=stopped` 保留 registration，但不 spawn；
5. 只启动 `desired_state=running`；
6. 不以“registry 中存在”直接等价为“必须运行”。

Supervisor 运行期间还必须执行带宽受限的 cwd reconcile，而不是只在下次进程启动时清理：

- 周期性检查 registration cwd，并可在 list/status/control 请求前合并触发一次去重检查；
- cwd 首次消失后立即禁止新 prompt/cron 投递；达到确认条件后停止 child、撤下 endpoint 并原子删除 registration；
- 检查间隔、连续缺失次数和短暂卷不可用的保护窗口在 Phase 0 冻结；
- 同一个失效项的并发 reconcile 必须合并，避免重复 stop/remove 和日志风暴；
- 直接 `git worktree remove`、手工删除或磁盘路径变化不依赖 supervisor 重启即可在有界时间内收敛。

## 12. Worktree 生命周期联动

受管 worktree 删除流程增加 daemon cleanup：

```text
确认 worktree 干净
→ 按 real cwd 查找 daemon registration
→ 若存在，停止 child 并注销
→ 删除 Git worktree
→ 验证 Git worktree 与 daemon registration 都已消失
```

要求：

- 未注册 daemon 时保持普通删除行为；
- cleanup 返回“已不存在”视为幂等成功；
- 未知错误必须明确报告，不得伪装成功；
- 外部直接执行 `git worktree remove`、手工删目录或磁盘变化由 supervisor 运行期 reconcile 在有界时间内停止 child、撤下 endpoint 并清理 registration；
- 不通过 `last_used` 猜测删除仍存在的 worktree daemon。因为注册已改为显式，长期保留由用户的 `desired_state` 决定。

worktree manager 位于独立 agent-tools 仓库；实现时需要单独冻结跨仓库接口和授权范围。Remote Pi 自身必须先提供按 cwd 查询和幂等 unregister 的稳定 CLI/API。

## 13. Daemon Readiness 与健康模型

### 13.1 正交状态

Daemon status 不再使用单一 `DaemonState` 承载全部语义：

```text
registration: registered | missing
desired:      running | stopped
process:      absent | spawning | running | exited
runtime:      pending | ready | failed
relay:        disconnected | connecting | connected | reconnecting
health:       stopped | starting | healthy | degraded | failed | blocked
```

输出同时包含：

```text
daemon_id
endpoint_id
runtime_instance_id?
pid?
cwd
kind=daemon
started_at?
uptime?
restart_count
startup_stage
last_error_code?
last_error_message?
last_error_at?
retrying
next_retry_at?
relay_state
```

### 13.2 健康计算

| 条件 | health | 动作 |
|---|---|---|
| `desired=stopped` 且无 child | `stopped` | 不启动 |
| child 已 spawn，等待 RPC/extension readiness | `starting` | 等待结构化握手和超时 |
| RPC、extension、Relay 都 ready | `healthy` | 正常服务 |
| RPC/extension ready，Relay 断线或重连 | `degraded` | extension 自行重连，不重启 Pi |
| child 意外退出、临时 spawn/RPC 故障 | `failed` | 按策略退避重试 |
| package 缺失、extension 冲突、配置非法、协议不兼容 | `blocked` | 停止自动重试，等待人工修复/显式 restart |

没有在线 Owner 不影响 health。Relay `connected` 表示 Extension 与 Relay 的认证 WebSocket 可用，不表示某个 PWA 当前打开。

### 13.3 结构化 readiness

Supervisor 不得通过“PID 存在”或解析自然语言日志推断 readiness。Extension 必须通过 Pi RPC stdout/control channel 上报结构化事件，至少覆盖：

```text
runtime_ready
relay_state_changed
session_changed
runtime_failed
```

`runtime_ready` 至少携带控制协议版本、extension 版本、endpoint/runtime identity 和当前 session identity。`runtime_failed` 携带启动阶段、稳定错误码、可重试性和安全的错误摘要。

Extension 无法上报“自身尚未加载成功”。因此 package 缺失、重复来源、extension discovery/load diagnostic 等 pre-readiness 错误，必须由 supervisor-owned 的版本化预检或 Pi 提供的结构化 startup diagnostic 识别。Phase 0 必须先证明该链路能够在目标 Pi 版本下复现 daemon 的真实加载环境；不得退化为匹配 stderr 自然语言。

stderr 只作为诊断附件保存有限尾部，不作为状态真源。Readiness timeout、事件 schema、preflight 方式和 supervisor/extension 兼容规则在 Phase 0 冻结。

### 13.4 `send` 的确认语义

`daemon send` 不再以 `child.stdin.write()` 成功作为 delivered。Supervisor 必须：

1. 确认 runtime ready；
2. 发送带 correlation ID 的 Pi RPC command；
3. 等待 Pi RPC 接受/错误响应；
4. 返回 `accepted` 或结构化失败。

Agent 最终回复仍通过 Remote Pi Protocol v2/Relay 时间线返回；`send` 不阻塞等待完整模型回答。

## 14. 重试与 Blocked 策略

### 14.1 可重试故障

- child 意外退出；
- 临时 spawn 资源错误；
- 已 ready runtime 的 RPC 通道异常退出；
- 明确标记为 transient 的启动错误。

采用有上限的指数退避；child 稳定运行一段时间后重置 restart budget。精确间隔、上限和稳定期属于 Phase 0 技术参数。

### 14.2 不可自动重试故障

- Remote Pi Pi-package 未安装；
- Remote Pi 被重复加载；
- 任一 extension 的确定性加载 diagnostic；
- cwd/config/schema 非法；
- Pi、supervisor 与 Remote Pi control protocol 不兼容；
- readiness 明确返回 `retryable=false`。

这些错误进入 `blocked`，取消 restart timer。解除方式：

- 用户修复后显式 `start/restart`；
- 安装/配置管理流程在检测到相关资源确实变化后触发重新预检；
- 不根据固定时间盲目重试。

### 14.3 Relay 故障

Relay 网络错误、服务不可达或连接重建只更新：

```text
relay=reconnecting
health=degraded
```

Extension 持续采用自身重连策略。Supervisor 不因 Relay 故障终止正在工作的 Pi，也不消耗 process restart budget。

### 14.4 Cron 调度门禁

Cron 能力保留，但不拥有 daemon 生命周期控制权：

- 只对 `desired_state=running` 且 `runtime=ready` 的 daemon 投递；
- `desired_state=stopped` 时记录 `desired_stopped` 并跳过，不能启动 child 或改写 desired state；
- `health=blocked` 时记录稳定错误码并跳过，不能绕过 package/config/readiness 预检；
- `starting/failed/retrying` 时记录当前状态并跳过，不能建立独立重启路径；
- `healthy` 和仅因 Relay 断线形成的 `degraded` 都允许本地 Cron 执行，因为 RPC runtime 仍 ready；
- Cron 投递必须复用 `daemon send` 的 RPC accepted/error 确认，不能只写 stdin；
- catch-up、手工 `cron run` 和正常定时触发使用同一门禁；
- 删除现有 `wake` 配置和 `wake_and_send` 语义，不迁移未上线产品的旧 Cron 数据。

Cron audit 必须记录 skip/accepted/error 原因，以证明调度没有改变 desired state 或绕过 blocked。

## 15. Extension 加载契约

Daemon 启动保留完整 Pi extension 环境：

```text
pi --mode rpc ...
```

Supervisor 不再附加：

```text
-e <global-remote-pi>/dist/index.js
```

规则：

1. Pi settings/package manager 是 Remote Pi extension 的唯一加载来源；
2. daemon enable/start 在 spawn 前预检 Remote Pi package 可被 Pi 发现；
3. 不使用 `--no-extensions`，其他用户和项目 extension 正常加载；
4. Pi runtime diagnostic 中任何 extension load error 都进入 `blocked`；
5. supervisor 与 extension 通过 control protocol version 判断兼容性，不要求 npm package 版本字符串完全相同；
6. 发现多个 Remote Pi 来源时明确列出来源并阻塞，不依赖 WeakSet 静默去重；
7. `REMOTE_PI_DAEMON=1` 和 daemon direct config 可继续用于运行模式与配置注入，但不能绕过 package/readiness 检查。

加载完整 extension 环境的代价是第三方 extension 的确定性失败也会阻塞 daemon。这是预期行为：daemon 应与同 cwd 的普通 Pi 能力一致，status 必须指出具体 extension 和错误来源。

## 16. 主要代码影响面

以下是实施前必须重新盘点的候选范围，不以本清单替代最终消费者扫描。

### 16.1 Pi Extension

删除或大幅收缩：

```text
pi-extension/src/session/broker.ts
pi-extension/src/session/broker_remote.ts
pi-extension/src/session/peer.ts
pi-extension/src/session/peer_inventory.ts
pi-extension/src/session/mesh_node.ts
pi-extension/src/session/bridge.ts
pi-extension/src/session/tools.ts
pi-extension/src/mesh/
pi-extension/src/mcp/mesh_server.ts
pi-extension/skills/agent-network/
```

重构：

```text
pi-extension/src/index.ts
pi-extension/src/rooms.ts              → endpoint identity/runtime 模块
pi-extension/src/transport/
pi-extension/src/pairing/
pi-extension/src/protocol/v2/
pi-extension/src/daemon/registry.ts
pi-extension/src/daemon/control_protocol.ts
pi-extension/src/daemon/rpc_child.ts
pi-extension/src/daemon/supervisor.ts
pi-extension/src/daemon/client.ts
pi-extension/src/daemon/install.ts
pi-extension/src/daemon/cron_registry.ts
pi-extension/src/daemon/cron_log.ts
```

### 16.2 Relay

删除：

```text
relay/src/mesh/
relay/src/handlers/pi_forward.rs
/mesh/:owner_pk_hash routes
mesh DB/config/auth cache
```

重构：

```text
relay/src/peers/registry.rs            → role-aware device/owner + endpoint registry
relay/src/handlers/peer.rs             → endpoint control/routing
relay/src/rooms.rs                     → endpoint discovery/metadata
relay/src/presence.rs                  → 仅保留设备/endpoint 所需语义
relay/src/lib.rs
relay/src/main.rs
```

### 16.3 Site/PWA

重构：

```text
site/src/components/pwa/pwa-app.tsx
site/src/components/pwa/session-sheet.tsx
site/src/lib/pwa/db.ts
site/src/lib/pwa/runtime.ts
site/src/lib/pwa/timeline-*.ts
site/src/lib/remote-pi/relay-client.ts
site/src/lib/remote-pi/peer-channel.ts
site/src/lib/remote-pi/protocol*.ts
site/src/lib/remote-pi/types.ts
```

删除或改写所有 mesh-local、mesh-remote、Claude mesh 教程、工具说明和 Agent Network 技能引用。

## 17. 实施阶段

### Phase 0 — 冻结协议与消费者清单

产物：

- endpoint/control/daemon readiness strict schema；
- endpoint/runtime ID 生成与接管规则；
- daemon registry v2 schema；
- CLI 目标命令表；
- 重试参数与运行期 cwd reconcile 间隔/确认条件；
- Cron 调度门禁、audit reason 和旧 `wake` 删除契约；
- Pi Extension、Relay、Site 和外部 worktree manager 的完整消费者清单；
- 明确的删除清单与替代清单。

出口条件：

- 无 `room_id`、mesh address、`#N` 或 agent peer 概念进入新 schema；
- Protocol v2 inner 与 Relay outer/control 边界清晰；
- 所有直接消费者和测试均已定位；
- 并行任务具有互斥文件所有权。

### Phase 1 — Relay Endpoint Registry 与独立配对

- 删除 mesh DB、`/mesh` API、Pi forward 和 Owner membership topology；
- 建立 role-aware device/owner authentication；
- 实现 endpoint snapshot/announce/end/update；
- 实现 `(device_id, endpoint_id, runtime_instance_id)` 路由和接管；
- 保证 Relay 不解析 Protocol v2 inner payload。

出口条件：Relay 单测覆盖 endpoint 并发、接管、迟到帧、Owner 授权、每台电脑独立配对和撤销。

### Phase 2 — Pi Extension 移除 Agent Mesh

- 删除本地 UDS broker、mesh node、bridge、inventory、tools、MCP 和 skill；
- root command 只启动 Relay endpoint；
- 生成并维护 process-scoped endpoint/runtime identity；
- 适配 `/new`、`/resume`、reload 和 shutdown；
- 上报 structured readiness、session change 和 Relay state。

出口条件：同一 cwd 多个 interactive Pi 可同时上线，彼此不可发现或通信；`/new` 保持 endpoint/runtime identity。

### Phase 3 — PWA Endpoint 模型

- 以 device/endpoint 替换 peer/room；
- 重建未上线产品的 IndexedDB schema 和 fixtures；
- endpoint 卡片展示类型、PID、cwd、状态和 metadata；
- 按 runtime instance 拒绝 stale realtime；
- 保持 Protocol v2 时间线、queue、model、thinking 和 extension UI 行为。

出口条件：一台 PWA 可管理多台分别配对的电脑及其多个 endpoint；不出现旧 room 兼容路径。

### Phase 4 — Daemon Desired State 与 Readiness

- registry v2；
- 显式 daemon registration；
- start/stop 持久化 desired state；
- supervisor startup + runtime cwd reconcile；
- 唯一 extension 加载来源预检；
- structured readiness、健康计算、RPC accepted ack；
- transient retry 与 deterministic blocked；
- Cron 统一使用 desired/readiness 门禁，删除 `wake` 绕过路径。

出口条件：status 不再把 process alive 等同于 healthy；Relay 断线只降级；扩展冲突稳定进入 blocked；Cron 不改变 desired state 或绕过 blocked。

### Phase 5 — Worktree、文档与清理

- Remote Pi 提供按 cwd 查询和幂等 unregister；
- worktree manager 删除时停止并注销 daemon；
- 删除/改写 mesh 教程、协议、README 和部署说明；
- 更新 Plan 00 中被正式反转的长期决策记录；
- 清理失效 package exports、skills、配置、环境变量和依赖。

出口条件：创建普通 worktree 不产生 daemon；删除已启用 daemon 的 worktree 不留下 registry 或 child。

## 18. 验证矩阵

### 18.1 自动化验证

Pi Extension：

```bash
cd pi-extension
pnpm typecheck
pnpm test
pnpm build
```

Relay：

```bash
cd relay
cargo test
```

Site：

```bash
cd site
pnpm test
pnpm test:coverage
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm build
```

每个冻结 diff 最后执行：

```bash
git diff --check
```

### 18.2 必测场景

| 场景 | 预期 |
|---|---|
| 同一 cwd 启动两个 interactive Pi | 两个独立 endpoint，均可由 PWA 选择，无 `#N` 协议身份 |
| 同一 cwd 同时运行 daemon 与 interactive Pi | 两个不同类型 endpoint，PID/身份明确 |
| Pi 执行 `/new` | endpoint/runtime/PID 不变，session/generation 更新，PWA 同卡切换 |
| daemon child 重启 | endpoint 不变，runtime instance/PID 更新，旧帧被拒绝 |
| Relay 断线 | daemon `degraded/reconnecting`，Pi 不重启，恢复后回到 healthy |
| Remote Pi package 缺失 | daemon blocked，不进入重启循环 |
| extension 重复或加载失败 | blocked，status 显示具体来源/阶段 |
| `daemon stop` 后 supervisor 重启 | daemon 保持 stopped |
| `daemon start` 后 supervisor 重启 | daemon 自动恢复并完成 readiness |
| supervisor 启动前 registry cwd 已删除 | supervisor 不 spawn，清理 stale entry |
| supervisor 运行时直接 `git worktree remove` | 无需重启，禁止新投递并在有界时间内停止 child、撤下 endpoint、清理 registration |
| 受管流程删除已注册 daemon 的 worktree | child 停止、registration 删除、worktree 删除 |
| Cron 命中 stopped daemon（含旧 wake 等价场景） | 跳过并记录 `desired_stopped`，不启动、不改 desired state |
| Cron 命中 blocked/starting/retrying daemon | 跳过并记录状态，不绕过预检或 restart budget |
| Cron 命中 ready + Relay degraded daemon | 经 RPC accepted 执行，Relay 重连由 extension 独立处理 |
| PWA 配对两台电脑 | 两台设备及各自 endpoints 同时可见，授权互不传播 |
| 撤销其中一台电脑 | 只影响该 device，不影响另一台 |
| `daemon send` | 返回 RPC accepted/error，不以 stdin write 作为 delivered |

### 18.3 真实链路验收

至少使用：

- 一个真实 Relay；
- 一台机器上的 daemon + 两个 interactive Pi；
- 第二台独立配对的电脑；
- 两个独立 Browser/PWA profile；
- supervisor 重启、child crash、Relay 中断和 `/new`。

验收证据包括结构化 status、Relay endpoint snapshot、PWA 页面状态、Protocol v2 时间线和无重复 endpoint/迟到帧。视觉与交互变更按项目 PWA UI 专项流程补充桌面/移动浏览器验收。

## 19. 非目标

- 不保留任何 agent-to-agent 通信兼容层；
- 不保留跨电脑 Owner membership；
- 不迁移旧 room、旧 PWA IndexedDB 或旧 daemon registry；
- 不提供 PWA 历史 Pi session 浏览或远程 `/resume`；
- 不把 endpoint 重新包装成 mesh peer；
- 不引入账号系统、云端 session persistence 或 Relay payload inspection；
- 不在本计划增加 daemon sandbox/container；
- 不把 Owner 在线状态纳入 daemon health；
- 不因 Relay 故障重启正在工作的 Pi；
- 不自动把每个 worktree 提升为 daemon；
- 不按 last-used 自动删除仍存在且由用户显式注册的 daemon。

## 20. 风险与约束

### 20.1 Relay 仍需要“发现与路由”，但不是 Mesh

移除 mesh 不等于 Relay 只维护单连接。保留多电脑、多 endpoint 必然需要 endpoint registry、授权发现和精确路由。实现中若把这层重新命名为 peer mesh，会再次混淆边界。

### 20.2 Pi Extension 是 Session-scoped

Pi 在 `/new`、`/resume`、`/fork`、`/clone` 时 shutdown/rebind extension。Endpoint/runtime identity 必须是 process-scoped；Relay handler 必须在新 session context 上重绑，不能复用 stale ExtensionAPI。

### 20.3 完整 Extension 环境扩大启动失败面

保留正常 Pi extensions 意味着第三方 extension 失败会阻塞 daemon。必须用可诊断的 blocked 状态处理，不能通过禁用全部 extension 隐藏问题。

### 20.4 跨仓库 Worktree 联动

Remote Pi 仓库不能单独保证所有 Git 删除入口都执行 teardown。受管 worktree manager 需要独立改动；supervisor reconcile 是不可省略的兜底。

### 20.5 破坏性协议切换

产品未上线允许直接切换，但三个子项目必须在同一兼容窗口完成。禁止阶段性部署新 Site 对旧 Relay、或新 Extension 对旧 Relay 后声称兼容。

### 20.6 Pre-readiness 错误分类依赖 Pi 能力

Remote Pi extension 只有加载成功后才能发送结构化 readiness。若 Pi 不提供结构化 startup diagnostic，supervisor 必须通过与真实 spawn 配置一致的 SDK preflight 获得机器可读结果；单纯解析 stderr 会再次把状态绑定到不稳定文案。Phase 0 在该链路验证前不得进入 daemon 状态实现。

## 21. Definition of Done

- [x] 本地及跨电脑 agent mesh 代码、工具、skill、协议和文档入口全部删除；
- [x] Relay `/mesh`、mesh DB、Owner membership topology 和 Pi forward 删除；
- [x] 每台电脑独立 pairing/revoke，多电脑多 endpoint 正常；
- [x] 新协议只使用 device/endpoint/runtime/session 术语；
- [x] 同一 cwd 多个 endpoint 不依赖 cwd/name/`#N` 身份；
- [x] `/new` 保持 endpoint/runtime，更新 session/generation；
- [x] daemon registration 显式，普通 worktree 不自动注册；
- [x] start/stop 持久化 desired state；
- [x] 删除 worktree 自动停止并注销 daemon；
- [x] supervisor 在启动和运行期间清理不存在 cwd，外部删除不依赖 supervisor 重启；
- [x] daemon status 分离 process、runtime、Relay 和 health；
- [x] Relay 断线只进入 degraded/reconnecting；
- [x] 配置/extension/protocol 错误进入 blocked 且不无限重试；
- [x] supervisor 不再通过 `-e` 重复加载 Remote Pi；
- [x] daemon 保留完整 Pi extension 环境并完成 package/readiness 预检；
- [x] `daemon send` 等待 RPC accepted/error；
- [x] Cron 只投递 desired running + runtime ready daemon，删除 `wake` 绕过语义；
- [x] stopped/blocked Cron、catch-up 和手工 run 均有门禁与 audit 覆盖；
- [ ] Pi Extension、Relay、Site 自动化验证和真实链路场景通过；
- [x] `git diff --check` 通过；
- [x] Plan 00、Protocol、README、daemon 文档和 PWA 文档与新架构一致。

## 22. 本轮收口记录

实现范围已完成：Relay endpoint registry/ACL/opaque route、Pi Extension endpoint/runtime 与双门槛 readiness、daemon desired/blocked/preflight/retry/Cron/cwd reconcile、PWA device/endpoint/session timeline、pairing QR、共享 Protocol v2 contracts、发布文档和生产文件职责拆分。

自动化验证：

- `cd pi-extension && pnpm verify`：29 个测试文件，331 passed、3 skipped，typecheck/build 通过；
- `cd relay && cargo fmt -- --check && cargo clippy --locked -- -D warnings && cargo test --locked`：全部通过；
- `cd site && pnpm exec tsc --noEmit --pretty false && pnpm test:legacy && pnpm test:component && pnpm lint && pnpm build`：117 legacy、64 component、typecheck/build 通过，lint 0 errors（3 个既有 `<img>` warnings）；
- 全部受影响生产 TypeScript/Rust 文件均不超过 600 行；`git diff --check` 通过；
- 旧 Mesh/room/broker/Pi-to-Pi/wake 生产语义扫描仅保留明确的 strict-rejection 测试 fixture 与否定性项目规范说明。

遗留风险：

- 尚未在真实 Relay、daemon、两个 interactive Pi、两个独立 PWA profile 上执行跨端 E2E；需要部署环境后验证 supervisor 重启、child crash、Relay 中断、runtime takeover、`/new` 和真实 pairing；
- 外部 `/Users/yefeng/Code/agent-tools` worktree manager 尚未接入 `unregister_cwd`，当前仓库通过 supervisor reconcile 提供兜底；
- 当前环境 Rust 1.91.1 低于项目建议的 1.94+，但本轮 check/clippy/test 均通过。

## 23. 后续更新规则

1. Phase 0 完成后，在本文补充最终 schema、CLI 和重试参数链接，不复制生成代码；
2. 每个 Phase 只更新状态、验证证据和仍有效风险；
3. 长期架构事实落入对应协议/架构文档后，本文保留决策原因和实施状态；
4. 被删除的旧计划保持历史原文，通过本文说明取代关系；
5. 出现新的产品取舍时先显式确认，再更新本文，不能在实现 PR 中顺带决定。
