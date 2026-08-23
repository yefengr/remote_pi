# 计划 63 — PWA 消息重复与稳定关联

## 背景

PWA 当前同时接收两条消息链路：

```txt
实时链路：PWA → Relay → pi-extension → PWA
历史链路：PWA → session_sync → pi-extension → session_history → PWA
```

同一条用户消息在两条链路中的 ID 不一致，导致 PWA 将同一条消息渲染为两条。

本记录只处理消息重复和历史关联，不包含 Relay 重连、连接状态 UI 或其他连接生命周期调整。

## 当前现象

用户从 PWA 发送消息时，PWA 生成随机 UUID，并发送：

```json
{
  "type": "user_message",
  "id": "A",
  "text": "hello"
}
```

`pi-extension` 的实时回显会保留这个 ID：

```json
{
  "type": "user_message",
  "id": "A",
  "text": "hello"
}
```

但历史同步时，扩展当前从自己的 `_messageBuffer` 读取 SDK 消息，再由 `_mapAgentMessagesToEvents()` 为用户消息重新生成：

```ts
const id = `sync_${timestamp}`;
```

因此 PWA 先后得到：

```txt
实时用户消息：A
历史用户消息：sync_<timestamp>
```

PWA 的 `mergeMessages()` 按消息 ID 合并，`A` 和 `sync_<timestamp>` 被认为是两条不同消息，于是出现重复。

助手消息也有同样的问题：

```txt
实时 agent_chunk.in_reply_to = A
历史 agent_message.in_reply_to = sync_<timestamp>
```

最终可能同时出现两条助手回复。

## 真实来源

### `_messageBuffer`

`_messageBuffer` 是 Remote Pi 扩展自己维护的进程内缓存，不是 Pi 官方 SDK 的历史存储：

```ts
let _messageBuffer: BufferMsg[] = [];
```

扩展在 Pi SDK 的 `message_end` 事件中，将已完成的 user、assistant 和 toolResult 消息放入该缓存。`session_compact` 事件还会额外写入一个 compaction 标记。

### Pi SessionManager

Pi 官方 SDK 同时会把 `message_end` 消息持久化为 SessionManager 的 `SessionMessageEntry`。外层 Entry 有 Pi 自己的唯一 ID、`parentId` 和时间戳，但嵌套的 SDK `UserMessage` 对象没有调用方提供的 PWA ID。

本次不修改官方 SDK。Pi 的 SessionManager 只作为扩展元数据持久化能力使用，不把 Pi Entry ID 直接当成 PWA 消息 ID。

## 已确定决策

| 决策 | 结论 |
|---|---|
| 是否保留 PWA 实时消息 | 保留。实时消息必须立即显示，并与回显按 ID upsert |
| 是否使用文本或时间戳去重 | 不使用。相同文本被发送两次必须保持两条消息 |
| 是否修改 Pi 官方 SDK | 不修改，不维护 fork |
| 是否修改 Relay | 不修改 |
| 历史 ID 来源 | 由扩展缓存保存稳定 ID，不再生成 `sync_<timestamp>` |
| 历史与实时合并 | PWA 继续按稳定 ID 合并 |
| 旧 IndexedDB 重复记录 | 不迁移、不清洗、不删除 |
| 旧会话历史 | 不尝试通过文本、时间或顺序猜测恢复 PWA ID |

## 最终方案

### 1. 扩展缓存保存稳定消息 ID

扩展将 `BufferMsg` 扩展为带有稳定关联字段的结构：

```ts
type BufferMsg = {
  id: string;
  replyTo?: string;
  role: "user" | "assistant" | "toolResult" | "compaction";
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number };
  tokensBefore?: number;
};
```

用户消息的 ID 由消息进入扩展时确定：

```txt
PWA user_message.id = A
BufferMsg.id = A
session_history.user_input.id = A
```

历史映射器直接使用 `BufferMsg.id`，删除 `sync_<timestamp>` 生成逻辑。

### 2. 扩展在入口处建立明确关联

关联必须在消息进入 Pi SDK 前建立，不能在 `message_end` 时通过文本或时间猜测。

| 消息来源 | `BufferMsg.id` |
|---|---|
| PWA 普通消息 | 使用 `user_message.id` |
| PWA steer 消息 | 使用该 steer 的 `user_message.id` |
| queued 消息 | 使用 queued item 的 ID |
| PWA 图片消息 | 使用原始 `user_message.id` |
| Pi 终端输入 | 扩展生成 UUID |
| RPC 输入 | 扩展生成 UUID |

相同文本的多条消息必须分别持有各自的 ID。steer 用户消息 ID 与当前助手回复目标分开保存：

```txt
当前助手回复目标：A
steer 用户消息：B

历史事件：
  user_input.id = B
  agent_message.in_reply_to = A
```

### 3. 实时事件和历史事件使用相同关联

实时助手流继续使用当前协议：

```json
{
  "type": "agent_chunk",
  "in_reply_to": "A",
  "delta": "..."
}
```

扩展缓存保存：

```ts
{
  id: "assistant-A",
  replyTo: "A",
  role: "assistant",
  content: "..."
}
```

历史映射输出：

```json
{
  "type": "agent_message",
  "in_reply_to": "A",
  "text": "..."
}
```

这样 PWA 的实时助手消息和历史助手消息会落到同一条记录。

### 4. 使用 SessionManager 持久化扩展关联元数据

`_messageBuffer` 是内存缓存，Relay 断开或 PWA 重连时仍可复用，但 Pi 进程完全退出后会丢失。因此扩展需要使用官方已有的扩展持久化能力保存 ID 元数据，例如：

```ts
pi.appendEntry("remote-pi-message-id", {
  wireMessageId: "A",
  role: "user",
  replyTo: undefined,
});
```

在新的 `session_start` 中读取当前 SessionManager 的 custom entries，恢复扩展的 ID 关联和历史缓存索引。

这一步不修改 Pi 官方 SDK，只使用扩展 API 已提供的 `appendEntry()` 和 `ctx.sessionManager` 读取接口。

### 5. `session_sync` 返回稳定 ID

`session_sync` 仍然是 PWA 请求历史的入口，但响应生成时不再为用户消息创建 `sync_<timestamp>`：

```txt
BufferMsg.id
  → user_input.id

BufferMsg.replyTo
  → agent_message.in_reply_to
```

PWA 继续使用现有的按 ID upsert/merge 逻辑：

```txt
本地乐观消息：A
实时 echo：A
session_history：A
```

最终只显示一条消息。

## 不处理的范围

- 不清理已经写入 IndexedDB 的重复记录；
- 不迁移旧消息 ID；
- 不使用相同文本、相近时间或数组位置进行历史去重；
- 不修改 Relay；
- 不修改 Pi 官方 SDK；
- 不处理 Relay 重连策略；
- 不承诺旧 `_messageBuffer` 或旧 session 中缺失关联信息的历史可以被无歧义修复。

## 实现范围

### pi-extension

- 扩展 `BufferMsg`，增加 `id` 和 `replyTo`；
- 在普通、steer、queued、图片、终端和 RPC 入口建立稳定关联；
- 移除 `_mapAgentMessagesToEvents()` 中的 `sync_<timestamp>`；
- 让历史 mapper 使用缓存中的 `id` 和 `replyTo`；
- 使用 SessionManager custom entry 持久化关联元数据；
- 在 `session_start` 恢复关联元数据；
- 清理消息完成或失败后的临时关联状态。

### site

- 保持实时消息按 ID upsert；
- 保持 `session_history` 按 ID merge；
- 确认历史响应不会生成第二条同一用户消息；
- 增加普通消息、相同文本、steer 和历史重放测试。

### app

- 不需要修改消息重复逻辑；
- 如协议类型发生字段变化，只做必要的类型同步和兼容测试。

## 验收标准

- PWA 发送一条普通消息后，实时回显和 `session_history` 合并为一条；
- 相同文本连续发送两次，仍显示两条独立用户消息；
- 实时助手流与历史助手消息只有一条；
- steer 用户消息使用自己的 ID，原助手回复仍指向原回复目标；
- queued 消息的 ID 从排队到历史保持不变；
- 图片消息的内容和 ID 都能在历史中恢复；
- Pi 终端和 RPC 输入不会与 PWA 消息混淆；
- Pi 进程重启后，已持久化的扩展关联可以恢复；
- 旧 IndexedDB 重复记录不被修改；
- 不存在基于文本、时间或 FIFO 猜测导致的误去重。

## 下一步

1. 先为 `pi-extension` 增加稳定 `BufferMsg` 关联和 custom entry 持久化；
2. 为普通、steer、queued、图片、终端和 RPC 路径补齐单元测试；
3. 修改历史 mapper 使用稳定 ID；
4. 在 PWA 增加实时消息与历史重放的回归测试；
5. 执行 `pi-extension` 和 `site` 的相关测试、lint、build 以及 `git diff --check`；
6. 完成一次在线发送、历史同步和 Pi 重启恢复的手工验证。
