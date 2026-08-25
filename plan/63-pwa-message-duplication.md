# 计划 63 — PWA 消息去重与权威会话时间线

## 状态

- 阶段 0A（Pi SDK 生命周期与 marker 基础拓扑验证）：**已完成（2026-08-24）**
- 阶段 0B（SDK 输入关联契约验证）：待完成
- Protocol v2、Extension、Site 生产实现：尚未开始
- Relay：无代码改动

本计划以 Protocol v2 消除 PWA 实时消息与 SessionManager 历史消息的重复。当前 Pi SessionManager branch 是正式历史真源；PWA IndexedDB 仅缓存最近 5 个回合组；PWA pending 和实时 partial 仅存在于内存。

Protocol v2 是强制升级，不能与 v1 互通。不得实现字段 fallback、双读双写、旧客户端兼容或自动降级。

## 阶段 0A 已完成的事实

阶段 0A 仅新增 `pi-extension/src/timeline/sdk_contract.test.ts`，未修改生产协议、PWA、Relay、Pi SDK、依赖或真实用户 session。测试使用真实 `Agent`、`AgentSession`、`ExtensionRunner`、`SessionManager`、`pi.appendEntry()` 和 `ctx.sessionManager.getBranch()`；模型 provider 使用本地可控 fake stream，不联网、不消耗模型额度。

已验证：

1. user、assistant、toolResult 的 `message_start` handler 可以追加 Remote Pi marker；`message_end` 内 marker 可见、目标 `SessionMessageEntry` 尚不可见；handler 返回后的下一 macrotask 可以从当前 branch 读取目标消息。
2. 目标消息紧随其 marker 持久化，且目标 `parentId` 指向 marker；临时 JSONL 中同样成立。
3. 真实工具回合实际执行一次，toolResult 的 `toolName`、成功状态和确定性结果均可恢复。
4. 两个独立 ExtensionFactory 在同一真实 `message_start` 内可形成 `marker -> custom -> target`。
5. `message_start` 期间 session 为 streaming；第三方 `pi.sendMessage()` 会进入 steer 队列，当前 SDK 形成 `marker -> target -> custom_message`，不能证明 `marker -> custom_message -> target`。
6. 下一个 Remote Pi marker 或角色不兼容消息会使未配对 marker 成为孤儿；`getBranch()` 仅返回当前 leaf 路径，`getEntries()` 仍含废弃 branch。
7. 持久化测试使用临时 session directory，并在结束后清理，无测试目录残留。

验证结果：定向契约测试 6/6 通过；测试文件严格单文件 TypeScript 检查通过；`pi-extension` typecheck 通过、全量测试 804 通过（3 skipped）、build 通过；`git diff --check` 通过。

阶段 0A 只证明生命周期、持久化窗口与 marker 基础拓扑。其 test-only scanner 曾为测试便利防御性跳过 `custom_message`；这不是生产恢复契约。生产 scanner 只能跳过阶段 0A 已实际证明安全的第三方 `custom` appendEntry，其余 entry 均为硬边界。

## 背景与目标

现有链路中，PWA 为发送动作生成随机 ID，扩展实时回显沿用该 ID；历史 mapper 又为同一 Pi user message 生成 `sync_<timestamp>`。PWA 按 ID 合并，因而同一用户消息和对应 assistant 回复可能重复。相邻问题还包括扩展内存 buffer 在 Pi 重启后丢失、工具事件未完整进入时间线，以及权威同步无法清除旧重复和孤儿缓存。

目标：

- 正式事件在实时、分页、重连和进程重启后拥有相同永久 ID，消除重复。
- 正式历史身份只由真实 Pi 生命周期和当前 SessionManager branch 决定；PWA 请求 ID 只管理发送状态。
- 同步 assistant、thinking、工具和可序列化系统事件；thinking 与工具默认折叠。
- 首次和缓存窗口均为最近 5 个原子回合组，可向上分页；活动组可包含在最新窗口中。
- 不建立 Remote Pi 独立历史数据库；IndexedDB 是可重建的有界缓存。
- 送达状态不明确时不自动重发，不猜测关联、文本、时间或位置。

非目标：

- 不修改或 fork Pi SDK，不修改 Relay，不实现 v1 兼容。
- 不镜像 Pi TUI 页头、页脚、编辑器、菜单、通知或第三方组件布局。
- 不传输 Pi 本地完整工具输出文件，不保证无限原始输出。
- 不新增 PWA 图片选择或发送流程；当前协议接受预算内的既有 Pi 图片在映射和分片中保持不损坏，旧数据中的超预算图片使用显式 `omitted` 元数据。
- 不承诺准确标注 Terminal、RPC 或 Steer 来源。

## 术语与不变量

| 术语 | 定义 |
|---|---|
| `client_request_id` | PWA 单次发送动作的临时 ID，只用于 pending、幂等、失败和 observed；绝不写入 marker、正式事件、SessionManager 或 IndexedDB 正式历史。 |
| `channel_id` | PWA 每次 Relay 连接随机生成的临时 ID；仅用于 v2 逻辑 channel 路由，绝不持久化，也不进入 marker 或历史。 |
| `senderRef` | 仅由已认证 Owner peer 派生的 opaque 引用；不由 tab、连接、文本或未认证 payload 派生。 |
| `message_id` | Pi 在真实 user `message_start` 为该 user entry 生成的永久 ID。 |
| `event_id` | 正式 TimelineEvent 的稳定 ID；user 使用 `message_id`，其他事件使用扩展稳定 ID。 |
| `group_id` | 回合组稳定 ID；组归属由 agent run 与持久化事件决定，独立于来源归因。 |
| marker | 使用 `pi.appendEntry()` 写入 SessionManager 的 `remote-pi:timeline-v2` metadata entry。 |
| 正式事件 | 已验证对应 Pi entry 已落盘、不可变且可从当前 branch 恢复的 TimelineEvent。 |
| partial | 仅用于实时渲染的可变状态，不是正式事件，不写入 marker 或 IndexedDB。 |
| snapshot head | 首次分页时冻结的当前 branch leaf，用于固定本轮分页视图。 |

同一 Owner/profile 的多个 PWA tab 都显示为 `You`。不新增或持久化 `client_instance_id`，不将 `channel_id` 用作身份、来源或历史字段。

## 已确定决策

| 决策 | 结论 |
|---|---|
| 协议升级 | Protocol v2 强制升级；拒绝 v1、缺失版本和未 hello 的业务帧。 |
| Relay | 无代码改动；继续透明广播 opaque payload，不理解 channel、目标或时间线内容。 |
| 历史真源 | 当前 `SessionManager.getBranch()` 的 branch。 |
| 扩展持久化 | 同一 Pi session JSONL 的最小 marker；不建立独立数据库。 |
| 旧 Pi entry | 无 Remote Pi marker 的 `SessionMessageEntry` 使用 `legacy:<pi-entry-id>`，`origin` 为 `unknown`；不恢复旧 PWA ID、source 或 steer。 |
| 输入关联 | 仅对 Remote Pi 自己在空闲时调用 `sendUserMessage` 的普通 PWA 消息使用 Node `AsyncLocalStorage`；在 user `message_start` 读取 correlation 并用 `WeakMap<AgentMessage, Correlation>` 绑定。 |
| 永久 ID | `message_id` 与其他 `event_id` 由真实 Pi 生命周期生成，不依赖 provenance、senderRef 或 `client_request_id`。 |
| 不可靠输入 | PWA steer、SDK followUp、terminal、RPC、第三方 `sendUserMessage` 缺少可靠 token 时均为 `unknown`；只有明确 SDK 能力证明为扩展发起时才可为 `extension`。 |
| PWA queued | 只有实际空闲排出且阶段 0B 验证通过时才是可靠 `pwa/queued`；否则为 `unknown`。 |
| 正式事件 | 不可变；assistant、thinking、tool 的 running 与 delta 只能走 `timeline_partial`。 |
| 分页 | 首次冻结 snapshot head；每页最多 5 个原子回合组；`before` 是绑定 session、generation、snapshot 与排他 branch 位置的服务端不透明 cursor。 |
| PWA 缓存 | Dexie 仅持久化最近 5 个正式回合组；partial 和更早页不持久化。 |
| 重试 | 送达不明不自动重发；generation 变化后旧业务帧不重发。 |

## Protocol v2

### 1. 逻辑 channel 与版本门禁

PWA 每次连接生成新的随机 `channel_id`。已配对连接必须先发送：

```json
{
  "type": "session_hello",
  "id": "H1",
  "protocol_version": 2,
  "channel_id": "C1"
}
```

Extension 以 `(authenticated owner peer, channel_id)` 维护逻辑 channel。`session_hello` 成功后发送定向响应：

```json
{
  "type": "session_ready",
  "in_reply_to": "H1",
  "protocol_version": 2,
  "target_channel_id": "C1",
  "session_id": "...",
  "history_generation": "..."
}
```

配对请求和配对成功也携带 `protocol_version: 2`。`session_ready` 之后：

- 每个 PWA -> Extension 业务帧必须携带 `protocol_version: 2`、`channel_id` 和当前 `history_generation`；
- `session_ready`、`user_message_started`、`user_message_status`、`session_history_chunk` 和结构化错误等直接响应必须携带 `target_channel_id`；
- `timeline_event` 等 Owner 级正式广播只携带 `protocol_version: 2`、`session_id` 和 `history_generation`，不绑定单个 `channel_id`。

Relay 仍向 room 广播。PWA 只处理发给自身 `target_channel_id` 的直接响应；Owner 级广播只在本地逻辑 channel 已 ready 且 session/generation 匹配时接收。

未 hello、版本缺失或版本不匹配的请求返回 `protocol_upgrade_required`。请求若携带格式合法的 `channel_id`，错误使用该 `target_channel_id` 定向；缺失或无法解析 channel 时只能发送不带目标的协议错误，并尽量保留可解析的 `in_reply_to`。已 ready 的 v2 PWA 必须忽略既不定向给自身、也不匹配本地待处理请求的错误。其他 generation、cursor 或参数错误只拒绝对应逻辑 channel。PWA 收到匹配自身请求的错误后主动断开；Extension 不拥有、也不声称关闭 Relay 的物理连接。

### 2. PWA 发送、关联与幂等

PWA 发送普通消息时生成临时请求 ID：

```json
{
  "type": "user_message",
  "protocol_version": 2,
  "channel_id": "C1",
  "history_generation": "...",
  "client_request_id": "R1",
  "text": "hello"
}
```

PWA 立即显示内存 pending。pending、accepted 和未知送达状态都不是正式历史，不能写入 marker 或 IndexedDB 正式表。

对空闲普通 PWA 调用，Extension 在自身 `sendUserMessage` 调用链建立 `AsyncLocalStorage` 请求作用域；user `message_start` 从作用域读取 correlation，生成 `message_id` 和必要 marker 后，以 `WeakMap<AgentMessage, Correlation>` 绑定具体 SDK 消息。真实 SDK 已知后续 handled 会让顺序账本留下孤儿，异步 handler 会使顺序反转；因此不得以 FIFO 推断 user 归属。steer 延后消费时 ALS 上下文会丢失，不能伪造关联。

只有可靠关联时，Extension 才能发送定向确认：

```json
{
  "type": "user_message_started",
  "protocol_version": 2,
  "target_channel_id": "C1",
  "in_reply_to": "R1",
  "session_id": "...",
  "history_generation": "...",
  "message": {
    "id": "M1",
    "group_id": "G1",
    "blocks": [{ "type": "text", "text": "hello" }],
    "origin": "pwa",
    "delivery": "normal"
  }
}
```

`user_message_started` 仅表示 SDK 已开始处理，不表示 Pi entry 已落盘。确认中的 `blocks` 使用 SDK 实际接收的有序文本与图片内容；入站 `user_message` 继续允许现有可选图片字段，图片也是幂等 payload 的一部分。`message_end` 后，Extension 必须在下一 macrotask 从当前 branch 验证 marker 与角色匹配的 `SessionMessageEntry` 已落盘；成功后才发布正式 `timeline_event`。无可靠关联时，不绑定 `client_request_id` 或 senderRef，不发送错误的 `user_message_started`，不猜测文本、时间或位置；相关 PWA pending 转为送达状态未知。

幂等键为 `(history_generation, authenticated owner peer/senderRef, client_request_id)`。有界 LRU 至少区分 `received`、`accepted` 和 `committed`：

- 相同键且 payload 相同：绝不再次调用 SDK；已有 accepted/committed 关联时重放对应确认，否则定向返回 `user_message_status` 与当前 `received` 状态。
- 相同键且 payload 不同：返回 `invalid_message`。
- `user_message_observed` 必须来自同一 senderRef。
- 容量、TTL 与 payload 比较算法是本地实现细节，不写入跨项目协议。
- generation 变化时清理或拒绝旧业务帧；PWA 不自动重发。

正式事件替换 pending 并完成持久化后，PWA 才发送：

```json
{
  "type": "user_message_observed",
  "protocol_version": 2,
  "channel_id": "C1",
  "history_generation": "...",
  "client_request_id": "R1",
  "message_id": "M1",
  "status": "committed"
}
```

该帧只用于清理幂等和重连状态；`client_request_id` 不进入正式历史。

### 3. 来源、投递与组归属

正式 user event 使用封闭字段：

```ts
type Origin = "pwa" | "extension" | "unknown";
type Delivery = "normal" | "queued" | "unknown";
```

`pwa` 仅用于可靠关联的 PWA 普通消息，或阶段 0B 后已经证明的实际空闲排出 queued 消息。`extension` 需要明确 SDK 能力证明为扩展来源。其余来源均为 `unknown`，包括没有可靠 token 的 terminal、RPC、PWA steer、SDK followUp 和第三方调用。UI 仅保证可靠 PWA 显示 `You` 或其他 PWA 的 `Remote`，以及经验证的 `Queued`；其他来源显示 `Unknown`。

`senderRef` 仅在可靠 PWA 来源保存，由认证 Owner peer 派生。它不表示 tab、物理连接或 PWA 安装实例。

组归属不依赖上述归因。阶段 0B 必须先锁定 `agent_start`、user `message_start`、queued user 和 `agent_end` 的真实顺序，再冻结等价的 run epoch 状态机。目标规则是：

- `agent_start` 打开新的 run epoch，`agent_end` 关闭并清理该 epoch；
- run epoch 内第一个没有 active group 的 user 建立 group，后续在同一 epoch 被 SDK 消费的 user 归入该 active group，但不因此推断来源或 delivery；
- 空闲普通 PWA 与实际空闲排出的可靠 queued 各自启动新 run，并建立新 group；
- steer 不新增 group；assistant 与 tool 按 run epoch 中的 active group 归属；
- 不得根据最近 user、全局指针跨 run 延续、文本或 FIFO 推导 assistant 回复根或 group。

若阶段 0B 证明当前 SDK 的事件顺序不满足上述边界，阶段 1 必须按真实事件选择等价 run boundary；在契约验证完成前不得实现隐含的全局 active-group 猜测。

因此方案不承诺 Terminal、RPC、Steer 的准确 UI 标签，也不需要将其作为永久 ID 的输入。

### 4. 正式时间线契约

阶段 1 必须冻结严格的运行时 schema，并让实时和历史复用同一 schema。不得以 `string`、`unknown` 或任意对象代替受控字段。

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type TextBlock = {
  type: "text";
  text: string;
  truncated?: true;
};

type ThinkingBlock = {
  type: "thinking";
  text: string;
  truncated?: true;
};

type ImageBlock =
  | { type: "image"; mime_type: string; data: string; byte_length: number }
  | { type: "image"; mime_type: string; byte_length: number; omitted: true };

type UserBlock = TextBlock | ImageBlock;
type AssistantBlock = TextBlock | ThinkingBlock;

type TimelineEventBase = {
  event_id: string;
  session_id: string;
  history_generation: string;
  timestamp: number;
};

type GroupedTimelineEventBase = TimelineEventBase & {
  group_id: string;
};

type TimelineToolEvent = GroupedTimelineEventBase & {
  kind: "tool";
  tool_call_id: string;
  tool: string;
  args: JsonValue;
  truncated: boolean;
} & (
  | { status: "complete"; result: JsonValue; error?: never }
  | { status: "error"; result?: JsonValue; error: string }
  | { status: "interrupted"; result?: never; error?: never }
);

type TimelineEvent =
  | (GroupedTimelineEventBase & {
      kind: "user";
      message_id: string;
      blocks: UserBlock[];
      origin: Origin;
      delivery: Delivery;
      status: "committed";
    })
  | (GroupedTimelineEventBase & {
      kind: "assistant";
      blocks: AssistantBlock[];
      status: "complete" | "interrupted";
    })
  | TimelineToolEvent
  | (TimelineEventBase & {
      kind: "compaction" | "branch_summary" | "custom";
      group_id?: string;
      payload: JsonValue;
      truncated: boolean;
    })
  | (GroupedTimelineEventBase & {
      kind: "provider_error";
      message: string;
    });
```

正式事件不可变：user event 必须满足 `event_id === message_id`；assistant 最终 entry 落盘后只发布一次；toolResult 落盘后只发布一次满足上述状态判别式的最终 tool event，空成功结果规范化为 `null`。assistant、thinking、tool 的 running 状态、delta 与临时输出只能发送 `timeline_partial`，不持久化。恢复时，有工具调用映射但没有 toolResult 的项目映射为 `interrupted`。

同一 `event_id` 的实时正式事件和历史事件必须内容完全一致；冲突时触发 reset，不能覆盖、合并、加 `sequence` 或 `revision`。阶段 1 的运行时 schema 还必须限制 ID、时间戳、MIME、字符串和数组大小，并拒绝不满足各状态判别式的事件。

## SessionManager marker 与恢复

### 1. 持久化内容

Remote Pi 不建立独立历史数据库。marker 与 Pi session 一起写入实际由 `ctx.sessionManager.getSessionFile()` 返回的 JSONL 路径。示例：

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

assistant 和其他需要独立稳定身份的持久 entry 也写最小 marker。marker 禁止存入正文、thinking、图片字节、工具参数、工具结果、partial、`client_request_id`、`channel_id` 或任意客户端实例标识。内容始终由相邻 Pi `SessionMessageEntry` 保存。

### 2. 恢复边界

恢复只扫描 `ctx.sessionManager.getBranch()`。从 Remote Pi marker 向后寻找角色匹配的目标 entry 时：

1. 只允许跳过阶段 0A 已证明安全的第三方 `custom` appendEntry。
2. `custom_message`、其他未证明安全的 entry、角色不兼容 message、下一个 Remote Pi marker、branch 结束均为硬边界。
3. 硬边界前未找到目标 entry 时，marker 是孤儿，必须忽略，不得向后继续猜测。
4. marker 或角色顺序异常时，仅拒绝该 marker 的关联，不能污染后续 entry。

阶段 0A 的 `marker -> target -> custom_message` 事实不允许将 `custom_message` 放宽为可跳过项。阶段 0B 与阶段 1 应修订相应测试预期，移除 test-only scanner 的宽松生产推论。

无 marker 的旧 `SessionMessageEntry` 仍可显示，稳定 ID 为 `legacy:<pi-entry-id>`，且 `origin: "unknown"`。这只保证旧 Pi 数据连续性，不恢复旧 PWA ID、sender、source、delivery 或 steer 关系。

## 历史分页与传输

### 1. 快照和 cursor

初始 `session_sync` 使用 `before: null`。Extension 固定当前 leaf 为 `snapshot_head`，并为下一页签发不透明 `next_before` cursor；cursor 绑定 `session_id`、`history_generation`、`snapshot_head` 和冻结 branch 上的排他 entry 位置。PWA 只回传该 cursor，不构造或解释其中字段；Extension 校验后通过 `getBranch(snapshot_head)` 读取冻结路径。普通 append 不使该快照失效。`snapshot_head` 必须仍属于当前 branch；session tree 或 branch 切换、session replacement、进程重启、恢复到不兼容 branch 时，Extension 改变 `history_generation` 并发送 reset。

每个逻辑窗口最多返回 5 个原子 group；“完整”仅指不拆分 group，不表示 group 已 finalized，最新窗口可以包含活动 group。compaction、branch summary 和 custom 等系统事件不建立或占用 group 配额，cursor 可以停在系统 entry 边界，因此没有 user group 的区间也能有界返回并继续前进。系统事件若可归入当前或相邻既有 group，可携带该 `group_id`；无法归组时不持久化到最近 5 组 Dexie 缓存，只保留在当前页面内存。

同一 cursor 同时只允许一个请求。连接中断、缺片、乱序或超时会丢弃未完成窗口；PWA 保留先前完整缓存。无效 cursor、generation 不匹配或快照不再适用时返回结构化 reset。每个成功窗口必须返回更早的新 cursor 或 `eos`，不能原 cursor 无限重试。

### 2. chunk、event fragment 与内存边界

每个 `session_history_chunk` 序列化为 JSON UTF-8 后最多 512 KiB。一个完整逻辑窗口组装后最多 32 MiB；服务端达到该预算时可以少于 5 个 group，但必须保持 group 原子性并返回可前进 cursor。单个 group 在形成正式事件前也必须规范化到该预算内：工具和 custom 最终内容最多 50 KiB；assistant/thinking 文本可使用 `truncated` block；当前协议接受范围内的图片必须完整保留，旧数据中的超预算图片改为带 MIME 与原始字节数的 `omitted` block。客户端与服务端都以 32 MiB 为未完成窗口硬上限。

小事件直接放入 `events`。单个严格 `TimelineEvent` JSON 超过单 chunk 时，不发送半成品 event，而是把完整事件 JSON 的 UTF-8 字节切片后，以 base64 event fragment 传输：

```ts
type TimelineEventFragment = {
  event_id: string;
  index: number;
  data_base64: string;
  final: boolean;
};

type SessionHistoryChunk = {
  type: "session_history_chunk";
  protocol_version: 2;
  target_channel_id: string;
  in_reply_to: string;
  session_id: string;
  history_generation: string;
  snapshot_head: string;
  chunk_index: number;
  events: TimelineEvent[];
  fragments: TimelineEventFragment[];
  final_chunk: boolean;
  next_before?: string;
  eos?: boolean;
};
```

`chunk_index` 与每个 `event_id` 的 fragment `index` 都从 0 连续递增。一个 event 要么完整出现在 `events`，要么只出现在 fragments，不能两者并存。收到 `final` 后，PWA 逐片 base64 解码、按 index 拼接 UTF-8 字节，再按严格 `TimelineEvent` schema 解析，且解析结果的 `event_id` 必须匹配；缺号、重复、乱序、超限或解析失败会丢弃整个未完成窗口。末个 history chunk 才携带 `next_before` 与 `eos`。

实时正式事件若超过单帧预算，复用相同的 `timeline_event_fragment` 结构并携带 `session_id`、`history_generation`；完整重组并通过严格 schema 前不可进入 UI 或 Dexie。WebSocket 有序，因此不增加 transfer hash 或预声明总片数。

### 3. Dexie 最近窗口

首次同步与实时正式事件共同维护最近 5 个 group。第 6 个 group 的 user 正式事件到达时，Dexie 在同一事务写入新 group，并删除最旧 group 的全部正式事件；partial 不持久化，不引入 `group_finalized`。

更早分页结果只保留在页面内存。最新窗口完整组装后才可原子替换正式缓存；同步期间同 generation 的实时正式事件需合并。权威窗口成功后清除旧 `sync_*`、重复和孤儿正式记录，保留内存 pending。离线只保证已缓存的最近 5 组可见。

## 失败、重连与 reset

PWA 没收到 `user_message_started` 或正式事件时，无法区分未送达、确认丢失、SDK 尚未处理与落盘前退出。因此：

- WebSocket 重连不重放业务帧。
- 可靠关联的未 observed 状态可在同一 Pi 进程内按幂等键重放给同一 senderRef；`user_message_observed` 用于清理。
- 不可靠关联不得补发错误确认；PWA pending 标为送达状态未知并保持在正式时间线外。
- generation 变化时，PWA 丢弃未完成传输窗口，将旧 pending 移至独立未知送达状态；先执行新的权威同步。
- 正式历史出现该消息则正常显示；未出现也不自动重发。
- 用户手动重发必须创建新的 `client_request_id`，并提示先前请求可能已经送达。

## 实现范围

### pi-extension

- 执行阶段 0B 的真实 SDK 输入关联验证；在完成前不将 queued 标记为可靠 PWA 来源。
- 冻结 v2 严格帧、错误、marker、TimelineEvent、fragment 和 fixture schema。
- 为自身空闲普通 PWA `sendUserMessage` 实现 ALS correlation 与 `WeakMap<AgentMessage, Correlation>`；不实现全来源关联账本。
- 在 `message_start` 写入最小 marker，在 post-`message_end` macrotask 验证当前 branch 落盘后才发布正式事件。
- 严格扫描当前 branch，恢复 marker 与 legacy entry，忽略孤儿。
- 维护 `(owner peer/senderRef, channel_id)` 逻辑 channel、generation、定向响应和有界幂等状态。
- 实现 snapshot 分页、512 KiB inner chunk、按需 fragment、内存边界与 reset。
- 映射 assistant、thinking、工具、compaction、branch summary、可序列化 custom 与 provider error；partial 仅实时。

### site

- 每次连接生成临时 `channel_id`，先完成 `session_hello/session_ready`；拒绝 v2 不匹配或逻辑 channel 错误。
- 维护内存 pending/accepted/送达未知状态；仅正式事件可写入 Dexie。
- 按严格 TimelineEvent 渲染用户、assistant、thinking、工具和系统事件；仅可靠 PWA 显示 `You/Remote`，其余显示 `Unknown`。
- 组装完整 history window 后原子更新最近 5 组缓存；同步期间先记录同 generation 实时正式事件，替换快照后再按 `event_id` 合并；更早页只留内存。
- 丢弃 generation 不符、定向目标不符或未完成/异常的 chunk 窗口；不自动重发业务帧。

### relay

无代码改动。只验证 v2 payload 仍被透明广播、定向响应由 PWA 忽略非目标帧，以及分页 payload 在既有转发预算内。

## 验证计划

### 阶段 0B：SDK 输入关联契约（待完成）

以下均须用真实 SDK 入口和可复现测试验证，未通过前不得把对应来源或 run 边界写成可靠：

1. later handled 导致顺序关联遗留孤儿的反例。
2. 异步 handler 导致顺序关联反转的反例。
3. 空闲普通 PWA 调用中 ALS correlation 正确绑定 `message_start` 的正例。
4. PWA queued 在实际空闲排出时的真实行为与可靠 `pwa/queued` 边界。
5. steer 延后消费导致 ALS 上下文丢失的边界。
6. `agent_start -> user/message/tool -> agent_end` 的 run epoch 顺序，以及 queued 与 steer user 是否位于同一 run 的边界。

阶段 0B 与阶段 1 必须把现有 test-only scanner 中对 `custom_message`、thinking/model change、label、session info、compaction 和 branch summary 等未获 0A 证明类型的防御性 skip 全部改为严格硬边界预期；只有真实证明安全的第三方 `custom` 可以跳过。

### Extension 自动化测试

- v1、缺失版本、未 hello、错误 channel 或旧 generation 的入站业务帧被逻辑 channel 拒绝；直接响应携带正确 `target_channel_id`，Owner 级正式广播不绑定 channel。
- 相同幂等键相同 payload 不重复调用 SDK；不同 payload 返回 `invalid_message`；observed 必须同 senderRef。
- 空闲普通 PWA：pending -> 可靠 `user_message_started` -> entry 落盘 -> 正式事件与历史一致。
- 无可靠 token 的输入不产生虚假确认、sender 或请求关联；PWA steer、followUp、terminal、RPC、第三方调用均保持 `unknown`，除非测试证明 extension 来源。
- queued 仅在阶段 0B 证明的实际空闲排出路径上为 `pwa/queued`。
- 普通与可靠 queued 组建立、active group 内未关联 user 归属、steer 不新建组、assistant/tool 不按最近 user 错误换根。
- marker 后进程退出、下一个 marker、角色不兼容 entry、`custom_message` 和 branch 结束均使孤儿不发布；已验证安全的第三方 `custom` 可跳过。
- current branch 恢复不混入废弃 branch；无 marker entry 使用 legacy ID。
- assistant 最终事件只发布一次，toolResult 最终事件只发布一次；partial 不进入历史；无 toolResult 恢复为 interrupted。
- 同 ID 实时与历史内容冲突触发 reset。
- snapshot append 稳定、branch 或 session 变化 reset、不透明 cursor 绑定与前进、每 cursor 单请求、chunk 连续性、32 MiB 窗口、超时丢弃和有界 event fragment 缓冲正确。
- 工具/custom 50 KiB 截断；超单 chunk 的 assistant/thinking/图片正确分片。

### Site 自动化测试

- ready 前不发送业务帧；每次连接的 `channel_id` 新鲜且不进入持久化数据。
- pending 和 accepted 不写 Dexie；仅正式事件替换 pending 并发送 observed。
- 不可靠关联和 generation 变化均转为送达未知，不自动重发。
- 同 ID 正式实时/历史内容冲突触发 reset；定向响应不匹配时被忽略。
- recent 5 group 原子持久化，第 6 组同一事务淘汰最旧完整组；partial 与早页不持久化。
- history chunks 必须完整、连续且同 generation/snapshot 后才对 UI 可见；异常窗口丢弃并保留旧缓存。
- snapshot 取点后、窗口原子替换前到达的同 generation 正式事件会先进入实时 journal，替换后按 `event_id` 合并；覆盖活动 group 追加事件与第 6 组淘汰顺序。
- 分片的历史和实时正式事件只有在完整重组、严格校验且未超 32 MiB 后才可见或持久化。
- reliable PWA 正确显示 `You/Remote`，经验证 queued 显示 `Queued`，其他来源显示 `Unknown`；thinking 和工具默认折叠。

### 最终验证

```txt
cd pi-extension && pnpm typecheck && pnpm test && pnpm build
cd site && pnpm lint && pnpm build
git diff --check
```

手工回归：普通发送、相同文本连续发送、已验证 queued、未知来源输入、多 PWA tab、工具/thinking、断线送达未知、Pi 重启、branch 切换、旧无 marker session、首次 5 组与连续向上分页。

## 验收标准

- Protocol v2 是唯一可用协议；PWA 入站业务帧在 ready 后携带版本、临时 channel 和当前 generation，直接响应按目标 channel 过滤，Owner 级正式广播不绑定 channel。
- Relay 无代码改动，Extension 仅维护逻辑 channel；错误由 PWA 主动断开。
- `client_request_id` 与 `channel_id` 均不写入 marker 或正式历史；`senderRef` 只来自认证 Owner peer。
- 不使用 FIFO、文本、时间、数组位置或最近 user 推断输入关联、永久 ID 或 assistant 根。
- 只有已验证 Pi entry 落盘的事件进入正式时间线；实时与历史同 ID 内容严格一致。
- `custom_message` 等未证明安全 entry 是 marker 恢复硬边界；旧无 marker Pi entry 仍以 legacy ID 连续显示。
- PWA 只对可靠普通与已验证 queued 输入显示来源和投递；其他不可靠输入不产生错误确认并显示 Unknown。
- latest 5 个原子 group 可完整缓存；活动 group 可在窗口内；早页不持久化；partial 永不持久化。
- snapshot 分页、opaque cursor、reset、event fragment 和 32 MiB 内存边界不会暴露半个 window、拆散 group 或让 cursor 无限停滞。
- 不自动重发送达不明请求；generation 改变后不重放旧业务帧。

## 实施顺序

### 阶段 0A：已完成

验证真实 SDK 生命周期、marker 基础拓扑、`custom` 交错、`custom_message` 延后顺序、孤儿边界和当前 branch 隔离；结果固定在 `pi-extension/src/timeline/sdk_contract.test.ts`。

### 阶段 0B：下一步

用真实 SDK 完成 later handled 孤儿、异步 handler 反序、空闲 ALS 正例、queued 实际空闲排出、steer 上下文丢失和 run epoch 顺序验证；将 scanner 测试中除已证明第三方 `custom` 外的防御性跳过全部收紧为硬边界。

### 阶段 1：协议、类型与入口边界

冻结严格 v2 schema、错误、fixture、marker、TimelineEvent 和入口边界；盘点直接消费者；不实现生产兼容层或宽松 schema。

### 阶段 2：Extension 最小永久提交链路

实现最小 marker、ALS、WeakMap、post-`message_end` 落盘验证、严格恢复和正式事件；先验证永久 ID、group 与历史 mapper 一致。

### 阶段 3：v2 逻辑 channel 与权威历史

实现 hello/ready、Owner/channel 逻辑路由、定向响应、generation、幂等、snapshot 分页、chunk、fragment 与 reset；Relay 只做透明转发验证。

### 阶段 4：Site pending、时间线与 IndexedDB

实现 pending/accepted/送达未知、严格 TimelineEvent UI、partial 内存渲染、最近 5 组 Dexie 事务替换和内存早页。

### 阶段 5：跨项目联调

以同一 v2 窗口联调 Extension 与 Site，覆盖多 PWA、可靠 queued、未知输入、工具/thinking、重启、branch 切换、分页和大内容；完成自动化验证、构建与手工回归后再更新计划状态。
