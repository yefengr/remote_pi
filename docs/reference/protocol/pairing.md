# Remote Pi Protocol v2 配对契约

本文件描述 Browser/PWA Owner 与单台 Remote Pi 设备的当前配对流程。配对作用域是 `device_id`：同一 Owner 可分别配对多台电脑，每台电脑独立授权、独立撤销，不存在跨设备 membership 传播。

## 1. QR payload

URI：

```text
remotepi://pair?t=<token>&epk=<device_id>&n=<display_name>&ep=<endpoint_id>&rt=<runtime_instance_id>
```

| query | 类型 | 规则 |
|---|---|---|
| `t` | Base64url，16 bytes | 必填；单次使用；默认 60 秒有效 |
| `epk` | Base64url，32 bytes | 必填；Host 设备 Ed25519 公钥；PWA 规范化为 Relay canonical Base64 STANDARD `device_id` |
| `n` | UTF-8 string | 必填；1–80 字符；仅展示用途 |
| `ep` | opaque UUID | 必填；发起配对的 endpoint |
| `rt` | opaque UUID | 必填；QR 生成时的当前 runtime |
| `r` | HTTP(S) Relay URL | 可选配置提示；PWA 若配置不一致必须提示，不得静默改写 |

拒绝重复 query、未知 query、错误 URI authority、无效 Base64、错误字节长度、非 UUID、空值和超长名称。没有 `ep` 或 `rt` 的 QR 无 fallback。

## 2. 为什么 QR 必须包含 endpoint/runtime

未配对 Owner 不在 Host ACL 中，因此不能依赖 ACL 受限的 endpoint discovery。QR 提供初始 route identity，PWA 可以直接发送：

```json
{
  "type": "route",
  "purpose": "pairing",
  "device_id": "<device_id>",
  "endpoint_id": "<endpoint_id>",
  "runtime_instance_id": "<runtime_instance_id>",
  "ct": "<Base64 STANDARD Protocol v2 pair_request bytes>"
}
```

Owner 原始 route 不得携带 `target_owner_id` 或 `source_owner_id`。Relay 完成 Owner challenge-response 后，向 Host 转发时注入可信 canonical `source_owner_id`。Host 只把该注入值当作待配对 Owner 身份；不从 inner payload 或客户端自报字段猜测 Owner。

若 QR runtime 已被新实例接管，Relay 将旧 runtime route 视为 stale；用户必须刷新 QR。

## 3. 配对流程

```text
Browser/PWA                              Relay                              Pi Extension
    | owner hello + Ed25519 auth           |                                     |
    |------------------------------------->|                                     |
    | pairing route(pair_request)          |                                     |
    |------------------------------------->| inject source_owner_id ------------>|
    |                                      |                       validate token |
    |                                      |                  persist Owner ACL   |
    |                                      |<------------- endpoint_update ACL --|
    |<-------------------------------------|<---- pairing route(pair_ok) ----------|
    | subscribe_endpoints(device_id)       |                                     |
    |------------------------------------->|                                     |
    |<---------------- endpoint snapshot --|                                     |
    | session route(session_hello)         |                                     |
    |------------------------------------->|------------------------------------>|
    |<---------------- session_ready ------|<------------------------------------|
```

### `pair_request`

inner frame：

```json
{
  "protocol_version": 2,
  "type": "pair_request",
  "id": "<request-id>",
  "token": "<t>",
  "device_name": "My Browser"
}
```

Extension 必须：

1. 使用 Relay 注入的 `source_owner_id` 作为 Owner 身份；
2. 原子校验 token 是否存在、未过期、未消费；
3. 消费成功 token；
4. 把 Owner 记录写入设备本地 `~/.pi/remote/peers.json`；
5. 通过 `endpoint_update.authorized_owner_ids` 同步 Relay ACL；
6. 向该 Owner 返回 `pair_ok`。

### `pair_ok`

```json
{
  "protocol_version": 2,
  "type": "pair_ok",
  "in_reply_to": "<request-id>",
  "session_name": "project",
  "session_started_at": 1788010000000,
  "endpoint_id": "<endpoint_id>",
  "harness": { "name": "Pi coding agent", "version": "<extension-version>" },
  "hostname": "<host-name>"
}
```

`endpoint_id` 必须与 QR/route endpoint 一致。PWA 将 pairing 保存为 device-scoped record，再独立维护 device 下的 endpoint records。

### `pair_error`

```json
{
  "protocol_version": 2,
  "type": "pair_error",
  "in_reply_to": "<request-id>",
  "code": "token_expired",
  "message": "Pairing token is invalid or expired"
}
```

稳定 code：

```text
token_expired
token_consumed
token_unknown
internal_error
```

错误响应后不得为该 Owner 开放 session route。

## 4. 本地授权存储

### Host

Host identity：

- 优先平台 keyring（macOS Keychain、Linux secret service、Windows Credential Manager）；
- headless fallback 为 `~/.pi/remote/identity.json`，文件权限 `0600`，父目录 `0700`；
- 已有 pairing 但身份不可读时不得静默生成新身份，否则会使全部 pairing 失效；应上报 deterministic blocked failure。

Owner ACL：

```json
{
  "peers": [
    {
      "name": "My Browser",
      "remote_epk": "<canonical-or-normalizable Owner Ed25519 public key>",
      "paired_at": "2026-08-29T00:00:00.000Z"
    }
  ]
}
```

该文件只属于这一台设备，不由 Relay 复制到其他设备。

### Browser/PWA

IndexedDB 保存：

- 一个 Owner Ed25519 identity；
- device-scoped pairing record：`deviceId`、Relay URL、pairedAt、nickname/hostname/harness；
- device+endpoint record及最新 runtime metadata；
- endpoint/session/generation scoped timeline。

Owner 私钥不得写入日志、URL、route metadata 或 Relay control frame。

## 5. 重连与 endpoint discovery

已配对 Owner 重连时：

1. 读取本地 Owner identity 与 device records；
2. 使用 Owner identity 对 Relay challenge 签名；
3. `subscribe_endpoints([device_id...])`；
4. Relay 只返回当前 Host ACL 仍包含该 Owner 的 endpoints；
5. PWA 对选中 endpoint/runtime 创建 session channel，发送 `session_hello`；
6. 收到 `session_ready` 后才能发送业务请求。

没有在线 Owner 不影响 daemon health；Relay 断线时 Extension 后台重连，不通过重启 Pi 修复网络故障。

## 6. 撤销

Host 本地撤销 Owner 时必须：

1. 从 `peers.json` 删除该 Owner；
2. 关闭该 Owner 的活动 endpoint binding；
3. 立即发送 `endpoint_update.authorized_owner_ids`；
4. Relay 对被撤销 Owner 发 `endpoint_ended`，并拒绝其后续 `purpose=session` route。

撤销只影响当前 `device_id`。其他电脑上的同一个 Owner pairing 不变。

## 7. 安全不变量

- Relay 对 Owner→Host 只信认证连接并自行注入的 `source_owner_id`。
- Owner 不能在 route 中自带 source/target Owner 字段。
- Host→Owner 必须指定 `target_owner_id`，且 session route 必须命中 Host 当前 ACL。
- Pairing route 绕过 ACL 仅用于 token 验证，不意味着 session 授权。
- token single-use；新 pairing 操作替换旧活动 token。
- endpoint/runtime 必须同时匹配；旧 runtime QR 和迟到 route fail closed。
- 不提供旧 QR、旧路由字段或旧本地数据库的兼容迁移。
