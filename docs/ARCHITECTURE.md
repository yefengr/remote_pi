# 当前架构

## 系统边界与拓扑

Remote Pi 由浏览器 PWA、Relay 和 Host 上的 Pi Extension 组成。Owner、device、endpoint、runtime 与 session 的含义见[背景与术语](CONTEXT.md#核心概念)。

```text
浏览器 PWA（/app）
        ↕ WebSocket / TLS
Relay（endpoint registry、ACL、路由）
        ↕
Pi Extension endpoint
        ↕
实际 Pi runtime / 当前 session
```

这是交互链路，不表示所有进程都由 daemon 启动。daemon supervisor 只管理显式注册的 RPC child，不是每条交互的必经中转。

| 子项目 | 职责 |
|---|---|
| [`pwa/`](../pwa/) | NextJS、React 与 TypeScript 实现的浏览器入口，负责配对交互、endpoint 选择、会话输入与时间线呈现。 |
| [`relay/`](../relay/) | Rust 与 Tokio 实现的 WebSocket Relay，负责 endpoint 注册、ACL 和路由。 |
| [`pi-extension/`](../pi-extension/) | Node 与 TypeScript 实现的 Pi 扩展、配对和远程会话协议，以及可选的 daemon 生命周期管理。 |

唯一产品路由为 `/app`，根路径 `/` 在服务端重定向至该路由。NextJS 提供路由、构建、standalone 产物和 Serwist 集成，不承担账号或业务 API 后台职责。

## 状态与持久化所有权

| 拥有者 | 持久或内存 | 用途 |
|---|---|---|
| 浏览器 `PwaDatabase` | IndexedDB 持久化 | 当前 profile 的身份、设备资料、endpoint metadata、正式时间线缓存和设置。 |
| 浏览器 `TimelineRuntime` | 页面内存 | pending、partial 等瞬态时间线状态。 |
| 浏览器历史分页 | 页面内存 | 正式缓存窗口之外的更早历史。 |
| Host | 本机持久化 | Host 身份、Owner 配对、daemon 意图与 Cron。 |
| Host 的 Pi session | 本机保存 | 实际 Pi `SessionManager` 当前 branch 是正式历史的真源。 |
| Relay registry | `HashMap` 内存 | 注册、ACL、subscriptions 和 senders；当前 Compose 不配置 Relay volume。 |

Host 数据的具体路径、权限与信任边界见[协议入口](../PROTOCOL.md)和 [daemon 指南](../pi-extension/docs/daemon.md)。Relay 内存状态的实现入口是 [`RegistryInner`](../relay/src/peers/registry.rs)。

浏览器数据库名为 `remote-pi-pwa`，表定义由 [`db.ts`](../pwa/src/lib/pwa/db.ts) 维护：

| 表 | 保存内容 |
|---|---|
| `identities` | 浏览器的 Owner 身份。 |
| `devices` | 设备与配对资料。 |
| `endpoints` | endpoint metadata，包括 last-known runtime 信息。 |
| `timelineEvents` | 有界的正式 timeline events 缓存。 |
| `settings` | PWA 本地设置。 |

endpoint metadata 可以落盘，但不代表 endpoint 当前在线。`use-endpoint-registry.ts` 的 `persistEndpoints` 在 `bulkPut` 前移除 `online` 字段，读取缓存时也将 `online` 强制设为 `false`。不能把缓存中的 runtime 资料或其他 metadata 当作实时在线证据。

## PWA 模块与会话数据流

`PwaApp` 编排应用启动、Relay/channel、选中 endpoint 的 session 与 UI。下列模块分别承接状态管理与呈现职责：

| 模块 | 职责 |
|---|---|
| [`use-endpoint-registry.ts`](../pwa/src/lib/pwa/use-endpoint-registry.ts) | endpoint 快照与缓存。 |
| [`use-device-pairing.ts`](../pwa/src/lib/pwa/use-device-pairing.ts) | 扫码配对。 |
| [`use-active-endpoint-selection.ts`](../pwa/src/lib/pwa/use-active-endpoint-selection.ts) | 设备与 endpoint 选择。 |
| [`use-timeline-viewport.ts`](../pwa/src/lib/pwa/use-timeline-viewport.ts) | 输出跟随与未读状态。 |
| [`timeline-runtime.ts`](../pwa/src/lib/pwa/timeline-runtime.ts) | 瞬态 timeline 状态。 |
| [`timeline-store.ts`](../pwa/src/lib/pwa/timeline-store.ts) | 正式 timeline 缓存与窗口替换。 |
| [`db.ts`](../pwa/src/lib/pwa/db.ts) | 表定义与存储基础。 |

正式缓存按 `TimelineScope` 隔离：

```text
deviceId + endpointId + sessionId + historyGeneration
```

runtime 不属于这个缓存分区键。会话时间线不能仅凭 endpoint 或当前进程信息混合读取。

会话数据流遵循以下边界：

1. 收到 `session_ready` 后，PWA 建立 scope、读取缓存并请求 recent history。缓存读取和历史请求是异步流程，不保证缓存读取完成后才发出请求。
2. pending 与 partial 只保留在 `TimelineRuntime` 内存，不写入正式事件表。
3. 正式 event 与 history 按稳定的 `event_id` 合流；完整历史窗口会与 realtime journal 合并，不能把历史响应简单视为对实时事件的无条件覆盖。
4. `selectRecentTimelineEvents` 与 `replaceRecentWindow` 按 `group_id` 保留最近五个 timeline groups（协议分组）的正式 events。这里的 group 不是“五条消息”，也不应直接等同于“五轮对话”；更早分页仅保留在内存。
5. 断线时，如果输入是否送达仍未知，PWA 不自动重发。

事件字段、分组和合流约束由[会话协议](reference/protocol/protocol-v2.md)维护，这里不复制 wire schema、错误码或尺寸预算。

## daemon 生命周期

daemon endpoint 在重启后保持稳定；interactive Pi 每个进程使用新的 endpoint。endpoint 的稳定性不意味着 runtime、session 或连接状态保持不变。

supervisor 区分 desired、process、runtime、relay 和 health 状态，不能将它们统一理解为一个 `running`。它只恢复 `desired_state=running` 的条目；如果 `cwd` 不存在，reconcile 会注销该条目。

RPC child 的启动与就绪边界是：

- child spawn 后，由宿主 `pi --mode rpc` 自己执行 settings、package 和 resource discovery，以及 diagnostics。
- supervisor 不运行私有 SDK，不重复预扫描，也不额外传入 `-e`。
- ready 需要 RPC `get_state`、Extension `runtime-ready`，以及匹配的控制协议和 endpoint/runtime。
- readiness 超时且 RPC 已 ready、Extension 仍未报告时，进入 `extension_not_ready` blocked；等待期间也不能只凭 RPC 响应认定 endpoint 已可用。

启动与握手实现见 [`rpc_child.ts`](../pi-extension/src/daemon/rpc_child.ts)。Relay 重连不等于重启 Pi；维护时应分别判断进程、Extension 就绪和连接状态。

Cron 消费期望状态、就绪状态、健康状态、忙闲和重试状态，只决定发送或跳过，不负责唤醒 Pi。注册、启动、停止和诊断命令继续由 [daemon 指南](../pi-extension/docs/daemon.md)维护。

## PWA 缓存与离线边界

Serwist 在构建时生成 `public/sw.js`，Service Worker 的 scope 为 `/app`。缓存策略如下：

| 请求类别 | 策略 |
|---|---|
| app 导航 | `NetworkFirst` |
| 静态资源 | `CacheFirst` |
| 其他同源请求 | `NetworkOnly` |

当前设置为 `skipWaiting=false`、`clientsClaim=false`。Service Worker 不拥有业务会话、配对或离线发送队列；WebSocket 和 IndexedDB 由页面控制。

离线读取仅限已缓存的页面壳与正式历史窗口，不能保证首次、从未在线访问的浏览器也能启动。缓存策略也不构成后台或锁屏持续连接、Web Push 的承诺。

浏览器接口支持与真实移动设备的未完验证见 [PWA 加固方案](plans/active/20260824-pwa-hardening.md)，不能将上述实现事实视为这些场景已经验收。

## 相关真源

- [协议入口](../PROTOCOL.md)、[会话协议](reference/protocol/protocol-v2.md)与[配对协议](reference/protocol/pairing.md)：身份、wire 字段、信任边界及协议约束。TLS 不等于应用层 E2E，Relay 运营方具有观察能力。
- [daemon 指南](../pi-extension/docs/daemon.md)：Host 生命周期、命令、存储路径与诊断。
- [部署说明](DEPLOYMENT.md)：构建、部署、配置与运维流程。
- [设计系统](DESIGN.md)：当前视觉规则；[主题方案](plans/active/20260830-pwa-theme.md)属于未来设计，不是当前实现。
- [协作规范](../AGENTS.md)与[路线图](ROADMAP.md)：仓库操作规则和唯一项目级事项状态。
