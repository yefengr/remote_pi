# Remote Pi Protocol v2

本文件是 Relay、Pi Extension 与 Browser/PWA 的当前跨端协议真源。实现必须以 strict schema 拒绝未知字段、错误方向和错误版本；不存在旧协议 fallback、双读或自动降级。

共享 machine-readable 样例位于 `fixtures/v2/manifest.json`。完整产品与安全说明见仓库根目录 [`PROTOCOL.md`](../../PROTOCOL.md)。

## 1. 身份与生命周期

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ session_id + history_generation
```

| 字段 | 语义 | 生命周期 |
|---|---|---|
| `owner_id` | Browser/PWA Owner 的 canonical Ed25519 公钥（Base64 STANDARD） | PWA 本地身份存在期间稳定 |
| `device_id` | Host 电脑的 canonical Ed25519 公钥（Base64 STANDARD） | 设备身份存在期间稳定 |
| `endpoint_id` | opaque UUID；一个可路由 Pi 入口 | daemon 跨 child 重启稳定；interactive Pi 每次进程启动生成 |
| `runtime_instance_id` | opaque UUID；endpoint 当前 OS 进程实例 | 每次进程 spawn 生成 |
| `session_id` | Pi SessionManager 会话 | `/new`、恢复、分支替换时可变化 |
| `history_generation` | 当前权威时间线代次 | session 或 branch 变化时更新 |
| `channel_id` | 一个 Owner 进入 endpoint 后的临时响应通道 | 当前实时连接/绑定 |

`cwd`、名称、PID、model、thinking、working 仅为 metadata，不是身份。`/new` 保持 endpoint、runtime 和 PID，只替换 session/generation。

持久时间线键是：

```text
device_id + endpoint_id + session_id + history_generation
```

`runtime_instance_id` 只用于实时 stale gate，不进入持久时间线主键。

## 2. Relay 认证

所有 WebSocket 客户端先发送 role-aware `hello`，然后完成 Ed25519 challenge-response。

### Host hello

```json
{
  "type": "hello",
  "protocol_version": 2,
  "role": "host",
  "pubkey": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "metadata": {
    "kind": "daemon",
    "name": "project",
    "cwd": "/absolute/path",
    "pid": 123,
    "started_at": 1788010000000,
    "model": "provider/model",
    "thinking": "high",
    "working": false
  },
  "authorized_owner_ids": ["<owner_id>"]
}
```

`metadata.kind` 只能是 `daemon | interactive`；其余 metadata 字段可省略。Host `pubkey` 必须等于 challenge-response 实际认证身份。

### Owner hello

```json
{
  "type": "hello",
  "protocol_version": 2,
  "role": "owner",
  "pubkey": "<owner_id>"
}
```

Owner hello 不得携带 endpoint、runtime、metadata 或授权列表。

### Challenge-response

```json
{ "type": "challenge", "nonce": "<Base64 STANDARD random bytes>" }
{ "type": "auth", "sig": "<Base64 STANDARD Ed25519 signature>" }
```

认证失败、身份与 hello 不一致、未知字段或 `protocol_version != 2` 都关闭连接。

## 3. Relay control frames

### Owner → Relay

```json
{ "type": "subscribe_endpoints", "device_ids": ["<device_id>"] }
```

订阅会替换该 Owner connection 的当前 device 集合。Owner 可以请求任意 device ID，但 Relay 只返回 Host ACL 中包含该 Owner 的 endpoint。

### Host → Relay

```json
{
  "type": "endpoint_update",
  "metadata": { "kind": "daemon", "working": true },
  "authorized_owner_ids": ["<owner_id>"]
}
```

`metadata` 与 `authorized_owner_ids` 至少存在一个。Host 只能更新当前权威 endpoint connection；旧 runtime 的更新被拒绝。

### Relay → Owner

Snapshot：

```json
{
  "type": "endpoints",
  "device_id": "<device_id>",
  "endpoints": [
    {
      "endpoint_id": "<UUID>",
      "runtime_instance_id": "<UUID>",
      "metadata": { "kind": "daemon", "cwd": "/repo", "working": false }
    }
  ]
}
```

增量事件：

```json
{ "type": "endpoint_announced", "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>", "metadata": { "kind": "daemon" } }
{ "type": "endpoint_updated",   "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>", "metadata": { "kind": "daemon" } }
{ "type": "endpoint_ended",     "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>" }
```

ACL 从无权变为有权时发 `endpoint_announced`，持续有权时发 `endpoint_updated`，被撤销或 endpoint 下线时发 `endpoint_ended`。

## 4. Relay route frame

所有业务 payload 使用统一 outer frame：

```json
{
  "type": "route",
  "purpose": "session",
  "device_id": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "target_owner_id": "<owner_id>",
  "source_owner_id": "<owner_id>",
  "ct": "<opaque string>"
}
```

`ct` 对 Relay 始终 opaque；当前客户端使用 Protocol v2 JSON UTF-8 bytes 的 Base64 STANDARD 表示。Relay 不解析、解码或记录 `ct`。

方向规则：

| 方向 | 必须 | 禁止 | Relay 动作 |
|---|---|---|---|
| Owner → Host | device/endpoint/runtime、`ct` | `target_owner_id`、`source_owner_id` | 鉴权后注入 canonical `source_owner_id` |
| Host → Owner | `target_owner_id`、device/endpoint/runtime、`ct` | `source_owner_id` | 只发给目标 Owner 的活动连接 |

`purpose`：

- `pairing`：仅用于 QR 配对交换；Owner 尚未进入 ACL 时仍可路由。
- `session`：Owner→Host 和 Host→Owner 都必须命中当前 Host 上报的 ACL。

相同 `(device_id, endpoint_id)` 只有一个权威 runtime。新 Host runtime 原子接管后，旧 Host connection、旧 runtime route 和迟到 frame 全部 stale，不能污染新 runtime。

## 5. Protocol v2 inner frame

所有 inner frame 都是 strict JSON object，必须携带：

```json
{ "protocol_version": 2, "type": "..." }
```

### 尺寸与数据边界

- 单 frame JSON UTF-8：最大 `2 MiB`。
- 单 history chunk：最大 `512 KiB`。
- 单 fragment 解码后：最大 `50 KiB`。
- 一个未完成逻辑窗口：最大 `32 MiB`。
- ID：1–256 字符。
- 普通字符串：最大 `1 MiB`。
- 数组：最大 4096 项。
- 时间戳：非负有限数。
- `JsonValue`：只能是递归 JSON 值。

### 路由字段类别

| 类别 | 字段 |
|---|---|
| pairing | `pair_request` / `pair_ok` / `pair_error`，不要求 session channel |
| PWA direct request | `channel_id` + `history_generation` |
| Extension direct response | `target_channel_id`；ready 后业务响应再带 session/generation |
| Owner broadcast | `session_id` + `history_generation`，不得带 `target_channel_id` |

配对完成后，PWA 必须先发送 `session_hello`；收到 `session_ready` 前不得发送 ready-only 业务 frame。

### PWA → Extension

- `pair_request`
- `session_hello`
- `user_message`
- `user_message_observed`
- `session_sync`
- `queued_message_set`
- `queued_message_clear`
- `approve_tool`
- `cancel`
- `ping`
- `session_new`
- `session_compact`
- `model_set`
- `thinking_set`
- `list_models`
- `extension_ui_response`

### Extension → PWA

- `pair_ok`
- `pair_error`
- `session_ready`
- `user_message_started`
- `user_message_status`
- `timeline_event`
- `timeline_partial`
- `timeline_event_fragment`
- `session_history_chunk`
- `protocol_error`
- `reset`
- `pong`
- `cancelled`
- `action_ok`
- `action_error`
- `models_list`
- `queued_message_state`
- `extension_ui_request`
- `bye`

## 6. Timeline 不变量

- `TimelineEvent` 是实时正式事件与历史事件的唯一 shape。
- `timeline_partial` 只表示实时可变状态，不进入 marker、SessionManager 或 IndexedDB。
- 正式 user event 满足 `event_id === message_id`。
- `origin=pwa` 必须携带 `sender_ref`；非 PWA origin 禁止携带。
- tool event 的 `complete | error | interrupted` 字段组合互斥。
- image block 的 inline `data` 与 `omitted=true` 互斥。
- history chunk 中同一 event 不得同时出现在 `events` 和 `fragments`；一个 chunk 内 fragment event ID 不得重复。

## 7. 错误与兼容策略

`protocol_error.code` 当前集合：

```text
protocol_upgrade_required
invalid_message
unsupported_type
invalid_channel
invalid_generation
invalid_cursor
reset_required
too_large
internal_error
```

未知 frame、未知字段、方向错误、缺少版本、v1 或未知版本都必须 fail closed。任何一端不得根据旧字段猜测 endpoint、runtime、channel 或 session。
