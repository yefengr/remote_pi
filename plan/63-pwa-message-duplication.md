# 计划 63 — PWA 消息重复与权威会话时间线

## 状态

方案已完成压力测试并冻结产品与架构边界；尚未实现。

本计划替代原先“PWA 客户端 ID 直接成为永久消息 ID”的方案。最终采用 Protocol v2：PWA 只持有临时发送请求 ID，Pi 在真实消息进入 SDK 生命周期时生成永久消息 ID；Pi SessionManager 当前 branch 是历史真源，PWA IndexedDB 只是最近 5 个回合的可重建缓存。

## 背景

PWA 当前同时接收两条消息链路：

```txt
实时链路：PWA → Relay → pi-extension → PWA
历史链路：PWA → session_sync → pi-extension → session_history → PWA
```

当前 PWA 为发送消息生成随机 ID，扩展实时回显时保留该 ID；历史 mapper 却为同一条 Pi user message 重新生成 `sync_<timestamp>`：

```txt
PWA 本地/实时消息：A
历史同步消息：sync_<timestamp>
```

PWA 按 ID 合并，因此同一条消息会显示两次。助手实时流指向 `A`，历史助手消息指向 `sync_<timestamp>`，也可能形成第二条助手回复。

当前实现还有三个相邻问题：

1. `_messageBuffer` 只是扩展进程内缓存，Pi 进程退出后会丢失；
2. PWA 只渲染用户、助手正文和 compaction，已存在的工具事件没有进入会话时间线；
3. `session_history` 与 IndexedDB 只做 merge，旧重复和孤儿记录不会被权威历史清除。

## 目标

- 消除实时消息、历史同步和进程重启后的重复记录；
- 让永久消息 ID 由实际进入 Pi 生命周期的消息产生，而不是由 PWA 乐观记录决定；
- 保留发送中的即时反馈，同时把发送状态与永久历史身份分离；
- 将 Pi SDK 可提供的会话时间线同步到 PWA；
- 工具调用和 thinking/reasoning 默认折叠；
- 首次只加载最近 5 个完整回合，向上滚动时按 5 个回合继续加载；
- 使用 Pi SessionManager 持久化少量 Remote Pi 关联元数据；
- 让当前 Pi session branch 成为权威历史，IndexedDB 成为有界缓存。

## 非目标

- 不修改或 fork Pi 官方 SDK；
- 不修改 Relay 的转发职责；
- 不完整镜像 Pi TUI 的页头、页脚、编辑器、菜单、通知和自定义组件布局；
- 不保证传输工具产生的无限原始输出；
- 不提供 Pi 本地临时完整输出文件的远程下载；
- 不自动重发送达状态不明确的用户消息；
- 不维护 Protocol v1 兼容路径；
- 不为 Remote Pi 建立独立历史数据库；
- 不新增 PWA 图片选择器或图片发送工作流；现有协议中的图片内容只需在关联和历史映射中保持不损坏；
- 不展示 Pi SDK 尚未向扩展事件 API 暴露的 `auto_retry_start/auto_retry_end` 状态；provider error 仍进入时间线。

## 术语

| 术语 | 含义 |
|---|---|
| `client_request_id` | PWA 一次发送动作的临时 ID，只用于 pending、失败、重试和确认，不进入正式历史 |
| `message_id` | Pi 在对应 user `message_start` 时生成的永久消息 ID |
| `event_id` | 一个永久时间线事件的稳定 ID；user message 使用 `message_id`，assistant 等事件使用扩展生成的稳定 ID |
| `group_id` | 一个完整会话回合组的稳定 ID |
| 回合组 | 一条启动回复的用户消息及其 assistant、thinking、工具、steer 和 provider error 事件 |
| marker | 通过 `pi.appendEntry()` 写入 SessionManager 的 Remote Pi custom metadata entry |
| 权威历史 | 当前 SessionManager branch 上可以恢复的正式时间线，不包含 PWA pending 和实时 partial update |

## 已确定决策

| 决策 | 结论 |
|---|---|
| 永久消息 ID 来源 | 由 Pi 侧在真实 `message_start` 时生成 |
| PWA 发送反馈 | 立即显示内存 pending，但 pending 不进入正式消息表 |
| 临时关联 | 允许使用入口建立、按 SDK 接收顺序消费的短期账本 |
| 禁止的关联方式 | 禁止按文本、时间戳或历史数组位置事后猜测 |
| SDK | 不修改、不 fork |
| Relay | 不修改 |
| 协议兼容 | Protocol v2 强制升级，不兼容 v1 |
| 历史真源 | 当前 Pi SessionManager branch |
| 扩展持久化 | 使用同一 Pi session JSONL 中的 custom marker |
| 独立数据库 | 不建立 `~/.pi/remote/history.db` |
| 历史分页 | 每个逻辑窗口最多 5 个完整回合组，可拆成多个 transport chunk |
| 加载交互 | 滚动到顶部自动加载更早一页，失败后提供重试 |
| PWA 持久缓存 | IndexedDB 只保存最近 5 个回合组 |
| 旧 IndexedDB 数据 | 权威同步成功后清除旧重复和孤儿记录 |
| thinking | 实时显示、最终内容持久化、默认折叠 |
| 工具 | 一次调用一条可更新记录，默认折叠；历史只保存参数和最终结果 |
| partial update | 只用于实时显示，不进入 SessionManager metadata 或 IndexedDB |
| 失败重发 | 送达状态不明确时绝不自动重发 |

## Protocol v2

### 1. 强制版本匹配

首次配对必须携带 `protocol_version: 2`：

```json
{
  "type": "pair_request",
  "protocol_version": 2
}
```

```json
{
  "type": "pair_ok",
  "protocol_version": 2
}
```

已配对 peer 的重连不会重新发送 `pair_request`，因此每条新建 session channel 还必须在任何业务消息前完成 hello：

```json
{
  "type": "session_hello",
  "id": "H1",
  "protocol_version": 2
}
```

```json
{
  "type": "session_ready",
  "in_reply_to": "H1",
  "protocol_version": 2,
  "session_id": "...",
  "history_generation": "..."
}
```

扩展在 channel 完成 hello 前拒绝 `session_sync`、`user_message` 和其他业务帧。缺失或版本不匹配时返回明确的 `protocol_upgrade_required` 并关闭该 channel。PWA 显示扩展必须升级，不静默降级，不根据包版本号猜测协议能力。

### 2. PWA 发送与正式确认

PWA 发送时生成临时请求 ID：

```json
{
  "type": "user_message",
  "client_request_id": "R1",
  "text": "hello"
}
```

PWA 立即显示内存 pending：

```txt
[发送中] hello
```

pending 不写入正式消息表，也不写入 IndexedDB。扩展将已交给 SDK 的 PWA 请求放入短期 provenance 账本。对应 user `message_start` 到来时：

1. 消费对应的 provenance；
2. 为真实 Pi user message 生成 `message_id`；
3. 确定 `group_id`、来源和投递方式；
4. 将 metadata marker 写入当前 SessionManager；
5. 用 `WeakMap<AgentMessage, Correlation>` 绑定具体 SDK 消息对象；
6. 只向发起 channel 返回 `user_message_started`。

发送方接受确认示例：

```json
{
  "type": "user_message_started",
  "in_reply_to": "R1",
  "session_id": "...",
  "history_generation": "...",
  "message": {
    "id": "M1",
    "group_id": "G1",
    "text": "hello",
    "origin": "pwa",
    "delivery": "normal"
  }
}
```

`user_message_started` 只表示 SDK 已开始处理，不表示 Pi message entry 已经持久化。PWA 使用远程 ID 和实际内容把通用“发送中”占位更新为内存中的 `accepted` 状态，但仍不写入 IndexedDB，也不丢弃内部 `client_request_id` 关联。

user `message_end` 后，扩展必须在后续 macrotask 重新读取当前 SessionManager branch，确认 marker 和对应 SessionMessageEntry 已经落盘。只有验证成功后，扩展才向所有连接方广播正式 `timeline_event`；发送方收到同 ID 的正式事件后清除 pending 并写入正式缓存。如果 Pi 在 marker 与 message persistence 之间退出，PWA 不会把孤儿 marker 当作已提交消息。

PWA 收到正式 `timeline_event`、完成 pending 替换和持久化后发送：

```json
{
  "type": "user_message_observed",
  "client_request_id": "R1",
  "message_id": "M1",
  "status": "committed"
}
```

扩展收到 committed observed 前保留有界的 sender-specific 内存映射，以便同一 Pi 进程中的重连重放 accepted 或 committed 状态；`client_request_id` 始终不写入 SessionManager marker 或正式时间线。

### 3. 终端、RPC、queued 与 steer

| 来源/投递 | 永久 ID | `group_id` |
|---|---|---|
| PWA 普通消息 | user `message_start` 生成 | 使用自身 `message_id` 建立新回合 |
| Pi 终端输入 | user `message_start` 生成 | 使用自身 `message_id` 建立新回合 |
| RPC 输入 | user `message_start` 生成 | 使用自身 `message_id` 建立新回合 |
| queued 消息 | 真正被 Pi 消费后的 user `message_start` 生成 | 使用自身 `message_id` 建立新回合 |
| steer 消息 | steer user `message_start` 生成自己的 ID | 归入当前 active `group_id` |

steer 用户消息身份与助手回复根必须分开：

```txt
当前回合：G1
当前助手回复根：M1
steer 用户消息：M2，group_id = G1

后续 assistant / tool event：group_id = G1
```

不能用“最近一条用户消息”推导 assistant 归属。

短期 provenance 账本覆盖所有可能产生 user SDK message 的入口，而不只覆盖 PWA：

```ts
type PendingInputProvenance = {
  origin: "pwa" | "terminal" | "rpc";
  delivery: "normal" | "queued" | "steer";
  senderRef?: string;
  clientRequestId?: string;
  replyRootId?: string;
};
```

PWA 在成功交给 SDK 时登记；terminal/RPC 在 `input` 事件中登记；queued 在真正交付时登记；steer 同时快照当前回复根。user `message_start` 严格按 SDK 消费顺序取出一项并绑定消息对象。该账本不参与历史恢复，也不决定永久 ID；只有 PWA 项携带 `client_request_id`。拒绝、handled/transformed input、取消、超时、session replacement 和 agent lifecycle 结束时必须清理或转移对应记录，不能让孤儿 provenance 污染下一条消息。

### 4. 来源和投递方式

正式 user event 持久化：

```txt
origin: pwa | terminal | rpc
delivery: normal | queued | steer
```

PWA 来源还保存由已认证 peer 派生的 opaque sender reference，但不在 UI 中显示原始公钥。

显示规则：

- 当前 PWA：`You`；
- 其他 PWA：`Remote`；
- Pi TUI：`Terminal`；
- RPC：`RPC`；
- `steer` 和 `queued` 作为紧凑投递标签显示。

### 5. 统一时间线上下文

正式实时广播和历史分页必须复用同一套 `TimelineEvent` union，不能分别维护两种松散结构。每个事件至少包含：

```ts
type TimelineEventBase = {
  event_id: string;
  group_id?: string;
  session_id: string;
  history_generation: string;
  timestamp: number;
};

type TimelineEvent =
  | (TimelineEventBase & { kind: "user"; message_id: string; origin: string; delivery: string; text: string })
  | (TimelineEventBase & { kind: "assistant"; blocks: unknown[]; status: "complete" | "interrupted" })
  | (TimelineEventBase & { kind: "tool"; tool_call_id: string; tool: string; args: unknown; result?: unknown; error?: string; status: string })
  | (TimelineEventBase & { kind: "compaction" | "branch_summary" | "custom" | "provider_error"; payload: unknown });
```

`history_generation` 在每次 extension session lifecycle 建立时生成；session replacement、Pi 进程重启或 branch 恢复会产生新值并迫使 PWA 重新加载最新缓存窗口。正式广播统一使用：

```json
{
  "type": "timeline_event",
  "session_id": "...",
  "history_generation": "...",
  "event": {}
}
```

实时 assistant/tool/thinking 增量使用独立 `timeline_partial`，同样携带 `session_id`、`history_generation` 和目标 `event_id`，但不属于正式历史。

## 权威时间线模型

### 1. 回合组

历史和 UI 的分页单位是完整回合组，不是底层事件数量：

```txt
回合 G1
├─ user
├─ assistant thinking
├─ assistant text
├─ tool call
├─ tool partial update（仅实时）
├─ tool result（最终）
├─ steer user
├─ assistant text
└─ provider error / done
```

普通、queued、终端和 RPC user message 建立新回合；steer 归入当前回合。compaction、branch summary 等跨回合系统事件按 SessionManager branch 顺序插入相邻位置，但不计入 5 个回合的数量。

### 2. 纳入时间线的内容

- 用户普通、queued 和 steer 消息；
- Pi 终端与 RPC 用户输入；
- assistant 正文；
- assistant thinking/reasoning；
- 工具调用名称、参数、运行状态、最终结果和错误；
- assistant 中已持久化的 provider error；
- compaction；
- branch summary；
- `display: true` 且内容可序列化的 custom message；
- Remote Pi 已支持的扩展交互请求和结果。

不纳入：

- TUI 页头、页脚、输入编辑器、快捷键提示和本地菜单；
- 普通 `ui.notify`；
- extension widget 和第三方自定义 TUI 组件布局；
- `display: false` 的内部 custom message；
- Remote Pi marker；
- 模型、thinking level、连接状态等房间元数据。

第三方 `display: true` custom message 使用通用折叠样式，展开后显示可序列化文本或 JSON，不尝试执行或复刻第三方 TUI renderer。

### 3. assistant 与 thinking

一次完成的 assistant SDK message 对应一个稳定 `event_id`。其文本和 thinking blocks 保持 SDK 顺序，避免当前 mapper 为多个 text block 生成相同 PWA ID后只保留最后一段。

实时 `text_delta` 和 thinking delta 更新当前事件；历史只保存 `message_end` 的最终内容。thinking 默认折叠，provider 没有返回时不创建空项。

### 4. 工具调用

工具记录以 `tool_call_id` 为稳定键：

```txt
tool_request           → 创建 running 记录
tool_execution_update  → 节流更新当前临时输出
tool_result             → 覆盖为最终成功/失败结果
```

规则：

- 参数和结果默认折叠；
- 运行状态与失败状态在折叠标题中可见；
- partial update 只存在于实时内存，按固定节流窗口合并，不能产生永久历史事件；
- SessionManager 和 IndexedDB 只保存参数与最终结果；
- 断线后无法恢复的 partial output 可以丢失；
- 没有最终 toolResult 且已不在运行的工具标记为 `interrupted`；
- 结果以 Pi `SessionMessageEntry.toolResult` 实际保存的内容为准；
- 文本型超大结果沿用 Pi 的默认边界：最多 2,000 行或 50 KiB，并携带 `truncated` 元数据；
- 不通过历史同步协议传输 Pi 本地完整输出文件。

## SessionManager 持久化

### 1. 存储位置

Remote Pi 不创建独立历史数据库。metadata marker 与 Pi 会话一起写入：

```txt
~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session-uuid>.jsonl
```

实际路径必须从 `ctx.sessionManager.getSessionFile()` 获取，兼容 `PI_CODING_AGENT_DIR` 和自定义 session directory。

### 2. marker 内容

marker 只保存恢复关联所需的 metadata，例如：

```ts
pi.appendEntry("remote-pi:timeline-v2", {
  version: 2,
  eventId: "M1",
  groupId: "G1",
  kind: "user",
  origin: "pwa",
  senderRef: "opaque-owner-ref",
  delivery: "normal",
});
```

assistant 等需要独立实时/历史身份的 SDK message 也写入自己的 marker。工具继续使用已有 `toolCallId`，不为每次 partial update 写 marker。

marker 禁止复制：

- 用户或 assistant 正文；
- thinking；
- 图片字节；
- 工具参数和结果；
- partial output；
- `client_request_id`。

这些内容继续由相邻的 Pi SessionMessageEntry 保存。

### 3. 写入和恢复约束

Pi SDK 当前先向扩展发出 `message_start`，在 `message_end` 扩展处理完成后才持久化对应 SessionMessageEntry。实现必须利用这个顺序建立明确契约：

1. 在需要稳定身份的 `message_start` 生成 ID 并追加 marker；
2. 用消息对象关联保存 metadata；
3. `message_end` 后安排 macrotask，重新读取 branch 并确认目标 SessionMessageEntry 已落盘；
4. 只有落盘确认成功后才广播正式 `timeline_event`；
5. 恢复时只扫描 `ctx.sessionManager.getBranch()`；
6. 从 marker 向后扫描时，可以跳过 `custom`、`custom_message`、model/thinking/label/session_info 等非目标 entry；第三方 `display:true` custom message 自己独立进入时间线；
7. 遇到下一个 `remote-pi:timeline-v2` marker 前，必须找到角色匹配的目标 SessionMessageEntry；下一个 Remote Pi marker 是硬边界，会使前一个未配对 marker 失效；
8. 扫描到任意不兼容的 SessionMessageEntry、branch 结束或 session 边界时，当前 marker 立即成为孤儿，不能继续顺延；
9. marker 后没有对应 message 时视为进程中断产生的孤儿，必须忽略；
10. marker 或角色顺序异常时停止该 marker 的关联，不能污染下一条消息。

实现前必须用当前 SDK 集成测试证明第三方扩展同时 append entry 时该拓扑仍然稳定。测试至少覆盖 `marker → custom → target`、`marker → custom_message → target`、`orphan marker → next Remote Pi marker` 和 `orphan marker → incompatible message`。若无法证明，不能退回文本、时间或宽松 FIFO 猜测，应重新评估 SDK 能力或调整确认时机。

### 4. 旧 Pi session 数据

Protocol v2 不兼容旧客户端，但旧 Pi session 文件仍可能缺少 Remote Pi marker。此类 SessionMessageEntry 可以使用稳定的 `legacy:<pi-entry-id>` 作为历史事件 ID，并将未知字段标为 `origin: unknown`；不得尝试恢复旧 PWA ID、steer 来源或客户端身份。

### 5. 磁盘占用

单条 marker 预计约 250–500 字节。按每回合一到两条 marker 估算：

| 回合数 | Remote Pi 额外占用 |
|---:|---:|
| 100 | 约 50–100 KiB |
| 1,000 | 约 0.5–1 MiB |
| 10,000 | 约 5–10 MiB |

主要磁盘占用仍来自 Pi 原有正文、thinking、图片和工具结果。删除 Pi session 时 marker 一起删除；compaction 和 branch 仍沿用 Pi 自己的 append-only 生命周期。

## 历史分页与 PWA 缓存

### 1. 分页协议

“5 个完整回合”是一个逻辑缓存窗口，不要求塞进一个 Relay envelope。初始请求：

```json
{
  "type": "session_sync",
  "id": "S1",
  "before": null,
  "limit_groups": 5
}
```

扩展把同一逻辑窗口拆成一个或多个 `session_history_chunk`：

```json
{
  "type": "session_history_chunk",
  "in_reply_to": "S1",
  "session_id": "...",
  "history_generation": "...",
  "snapshot_head": "...",
  "chunk_index": 0,
  "events": [],
  "final_chunk": false
}
```

最后一个 chunk 设置 `final_chunk: true`，并携带 `next_before` 和 `history_eos`。所有 `events` 都使用统一 `TimelineEvent` union。PWA 必须完整组装逻辑窗口后再对 UI 和 IndexedDB 原子可见；连接中断或任一 chunk 无效时丢弃未完成窗口，保留原缓存。

约束：

- `limit_groups` 服务端最大值固定为 5；
- 一个逻辑窗口最多包含 5 个完整回合，可跨任意数量的 transport chunk；
- 每个 transport chunk 使用低于 Relay 4 MiB 硬上限的独立安全预算，并为 JSON/base64 framing 保留余量；
- 回合可以跨 transport chunk 组装，但在窗口完成前不能向用户暴露半个回合；
- 工具结果沿用 2,000 行/50 KiB 边界；可序列化 custom payload 也应用明确的 50 KiB 上限并标记 `truncated`；
- assistant、thinking 和现有图片等 Pi 持久内容使用带 `event_id/block_index` 的内容分片跨 chunk 重组，不能让单个可变长字段突破 envelope；
- compaction 等系统事件随相邻时间区间返回，但不占回合配额，仍受 chunk 预算约束；
- `before` cursor 必须绑定 `session_id`、`history_generation` 和 `snapshot_head`；
- branch 已变化、generation 不匹配或 cursor 不再有效时返回结构化 `history_reset_required`，PWA 丢弃未完成窗口并重新加载最新窗口；
- 同一 cursor 请求进行中时禁止重复请求；
- 所有边界情况下 cursor 必须前进或明确 reset，禁止返回空 chunk 后原 cursor 无限重试。

### 2. 加载交互

- 首次进入加载最近 5 个完整回合；
- 滚动到时间线顶部自动请求更早 5 个回合；
- 顶部 loading 行使用稳定高度；
- 加载完成后保持原可见内容的滚动锚点；
- 失败时显示“加载失败，点击重试”；
- 到达会话开始后停止继续请求。

### 3. IndexedDB 策略

IndexedDB 只持久化当前 room 最近 5 个正式回合。更早分页只保留在当前页面内存，刷新后按需重新加载。最近 5 回合逻辑窗口可能由多个 transport chunk 组成；窗口完整前保留旧缓存并标记同步中，只有完整组装后才能替换。

最新逻辑窗口权威同步成功后：

1. 在事务中替换该 room 的正式缓存；
2. 清除旧 `A`、`sync_*`、重复和孤儿记录；
3. 保留当前内存 pending；
4. 合并同步期间新到达且属于同一 `session_id/history_generation` 的实时正式事件；
5. 不把 partial tool、assistant 或 thinking update 写入 IndexedDB。

离线时只保证最近 5 个已缓存回合可见，不保证访问更早历史。

## 发送失败与重连

PWA 没收到 `user_message_started` 或正式 `timeline_event` 时，无法区分请求未送达、接受确认丢失、Pi 尚未开始处理或 message 尚未持久化。因此：

- WebSocket 重连不重放业务消息；
- 扩展在内存中保留有界的 sender-specific `client_request_id → message_id/status` 映射，直到 PWA 回应 `user_message_observed` 或映射过期；
- 同一 Pi 进程内重连并执行 `session_sync` 时，扩展向原 sender 重放仍未 observed 的接受/提交映射；
- 未确认 pending 在明确连接失败后显示“送达状态未知”，但保持在正式时间线之外；
- Pi 进程重启导致 `history_generation` 变化时，PWA 将旧 pending 移入独立的未知送达状态区，不与正式历史混排；
- 重连后先执行权威 `session_sync`；
- 历史中出现正式消息时按正常事件显示；
- 没出现时仍不自动重发；
- 用户手动重发前提示上一条可能已送达，重复发送可能导致重复执行；
- 手动重发创建新的 `client_request_id`。

## 实现范围

### pi-extension

- 在首次配对和每条新 session channel 上强制校验 Protocol v2 hello；
- 用覆盖所有输入来源的 provenance 账本和 `WeakMap<AgentMessage, Correlation>` 绑定 `message_start/message_end`；
- 为 user、assistant 和需要稳定身份的系统事件生成永久 ID；
- 分离 user `message_id`、active `group_id` 和 assistant 回复根；
- 为 PWA、终端、RPC、queued 和 steer 建立来源与投递 metadata；
- 使用 `remote-pi:timeline-v2` custom marker 持久化最小 metadata；
- 在 post-`message_end` macrotask 验证 Pi message entry 落盘后才发布正式事件；
- 从当前 SessionManager branch 恢复时间线，按硬边界忽略孤儿 marker；
- 用 `legacy:<pi-entry-id>` 读取无 marker 的旧 Pi session 内容；
- 定义实时和历史共用的 `TimelineEvent` union 与 `session_id/history_generation` 上下文；
- 将 assistant text/thinking、tool、compaction、branch summary、custom message 和 provider error 映射为稳定时间线；
- 工具 partial update 节流，最终结果采用 Pi 既有截断边界；
- 将 5 回合逻辑窗口拆成受 Relay 预算约束的 `session_history_chunk`，实现内容分片和游标 reset；
- 维护有界 sender-specific request 映射并处理 `user_message_observed`；
- 在 session replacement、失败、取消和结束路径清理临时关联状态。

### site

- 每条新 session channel 先完成 v2 `session_hello/session_ready`，不匹配时阻止进入并提示升级扩展；
- 将发送中的 PWA 消息保存在内存 pending，不写入正式消息表；
- 使用 `user_message_started` 的远程内容把 pending 更新为非持久化 `accepted`；
- 只在正式 `timeline_event` 到来后清除 pending、发送 `user_message_observed` 并持久化；
- 新建分组化时间线数据模型，不再只依赖 `PwaMessageRecord.text`；
- 渲染用户、assistant、thinking、工具和系统事件；
- thinking 和工具默认折叠，工具状态在折叠标题可见；
- 区分 `You / Remote / Terminal / RPC` 与 `Steer / Queued`；
- 实时 `timeline_partial` 只更新内存状态，最终事件才持久化；
- 完整组装最近 5 回合逻辑窗口后原子替换缓存，顶部自动加载更早窗口并保持滚动锚点；
- IndexedDB 只保存最近 5 个正式回合；
- 最新逻辑窗口同步后清理旧重复和孤儿记录；
- generation 变化时把旧 pending 移出时间线并标记送达未知；
- 送达状态未知时不自动重发。

### relay

不修改。继续把 Protocol v2 payload 当作不透明内容转发。现有单 envelope 上限仍是分页和单项截断的硬约束。

## 验证计划

### pi-extension 自动化测试

- 首次配对和已配对重连都必须完成 v2 hello，业务帧不能绕过；
- 普通 PWA 消息：pending request → `message_start` accepted → Pi entry 落盘 → 正式事件/history 一致；
- marker 后进程退出时不发布正式事件，恢复时忽略孤儿；
- 连续两条相同文本拥有不同正式 ID；
- PWA、terminal、RPC、queued 和 steer provenance 按 SDK 接收顺序绑定，不比较文本或时间；
- handled/transformed、rejected、cancelled、超时和 session replacement 不遗留可污染下一条消息的 provenance；
- steer 有独立 user ID，但 assistant/tool 仍归属原 active group；
- queued 在实际消费时才生成永久 ID；
- 多 owner 下 `user_message_started` 只回复发起 channel，正式事件广播；
- `user_message_observed` 清理映射，同进程重连可重放未 observed 映射；
- assistant 多 text/thinking block 保持顺序且不会被同 ID 覆盖；
- tool partial 不进入历史，最终结果可恢复并保留 error/truncated；
- marker 与第三方 `custom/custom_message` 交错时仍正确绑定；
- 下一个 Remote Pi marker 或不兼容 message 会使前一孤儿 marker 失效；
- 只恢复当前 branch，不混入废弃 branch；
- 无 marker 的旧 SessionMessageEntry 使用稳定 legacy ID；
- 5 回合逻辑窗口可跨多个 transport chunk，完整组装前不发布半个回合；
- 超大 assistant/thinking/image 内容分片不突破单 envelope 预算；
- stale cursor 或 generation 不匹配返回 `history_reset_required`；
- Protocol v1、缺失版本或未 hello channel 被明确拒绝。

### site 自动化测试

- 新 session channel 在 ready 前不发送业务帧；
- pending 和 `accepted` 都不写入 IndexedDB；
- `user_message_started` 按 `client_request_id` 更新正确 pending，正式事件才完成持久化；
- 两条相同文本 pending 不混淆；
- 正式广播和历史同 ID upsert，并发送 `user_message_observed`；
- 送达状态未知时不自动重发，generation 变化后不与正式时间线混排；
- 用户来源和 delivery 标签正确；
- thinking、工具默认折叠并可展开；
- tool partial 更新 running 卡片但不持久化；
- 最终 tool result 覆盖 running 状态；
- 多个 `session_history_chunk` 完整组装前不替换旧缓存；
- 初始逻辑窗口完成后只持久化最近 5 个回合；
- 向上窗口只保存在内存并保持滚动锚点；
- 最新逻辑窗口权威同步清除旧 `sync_*`、重复和孤儿记录；
- 同步期间同 generation 的实时事件不会丢失；
- Protocol v2 不匹配时显示阻断式升级提示。

### 最终验证

```txt
cd pi-extension && pnpm typecheck && pnpm test && pnpm build
cd site && pnpm lint && pnpm build
git diff --check
```

另需手工验证：

- 普通发送、相同文本连续发送、steer、queued、终端和 RPC；
- 多 PWA 同时连接时的来源标签和 sender-only pending 确认；
- 工具与 thinking 的折叠、展开和实时更新；
- PWA 断线、送达状态未知、重连同步和手动重发提示；
- Pi 进程退出后恢复当前 branch；
- 含孤儿 marker、旧无 marker session 和 branch 切换的历史；
- 首次 5 回合、顶部连续分页和刷新后旧页重新加载。

## 验收标准

- PWA pending/accepted 与正式记录严格分离，正式历史中不存在 `client_request_id`；
- 只有已验证 Pi SessionMessageEntry 落盘的消息才能成为正式 `timeline_event`；
- 同一正式事件在实时广播、历史分页和进程重启后保持同一个 ID；
- 相同文本连续发送仍是两条独立消息；
- 不使用文本、时间戳或历史数组位置恢复关联；
- 短期顺序账本异常不会污染永久历史身份；
- steer 用户消息有自己的 ID，但当前 assistant/tool group 不被错误切换；
- thinking 和工具可见、默认折叠，partial update 不进入永久历史；
- 最近 5 个完整回合在逻辑窗口全部组装后原子缓存并可离线读取，更早回合按需加载且不持久化；
- 权威同步会清除旧 IndexedDB 重复和孤儿记录；
- 送达状态未知的消息不会自动重发；
- 当前 branch 可在 Pi 进程重启后从 SessionManager 恢复；
- 孤儿 marker、旧 session 和废弃 branch 不会污染当前时间线；
- Protocol v1、缺失版本或未完成 hello 的 channel 不能静默进入 v2 会话；
- Remote Pi 不复制会话正文，metadata 磁盘开销保持在每回合约 0.5–1 KiB 的量级；
- Relay 无代码改动。

## 实施顺序

1. 先用独立集成测试验证 SDK 生命周期顺序、post-persistence 确认、marker 拓扑和孤儿恢复；
2. 定义强制 channel hello、统一 `TimelineEvent`、`history_generation`、回合窗口和 chunk 协议；
3. 实现 pi-extension provenance、永久 ID、marker、正式提交确认和 branch 恢复；
4. 实现 request observed/replay、工具/thinking 时间线及最终历史 mapper；
5. 实现 5 回合逻辑窗口、transport chunk、内容分片、cursor reset 和响应字节预算；
6. 改造 PWA pending/accepted、分组时间线、折叠 UI 和来源标签；
7. 改造 IndexedDB 为最近 5 回合完整窗口的权威缓存；
8. 完成自动化验证后执行多来源、断线、重启和分页手工验收。
