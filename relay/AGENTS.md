# Remote Pi — Relay（Rust）

WebSocket Relay：认证 Browser/PWA Owner 与 Pi Host 连接，在内存中维护 device/endpoint/runtime registry 和每个 endpoint 的 Owner ACL，发布 endpoint snapshot/update，并转发 opaque `ct` route。

Relay 不提供 Agent Mesh、Pi-to-Pi forwarding、room/presence、membership API、SQLite storage 或 message queue。当前跨端真源见 [`../PROTOCOL.md`](../PROTOCOL.md) 和 [`../docs/reference/protocol/protocol-v2.md`](../docs/reference/protocol/protocol-v2.md)。系统关系与状态所有权见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；本文件只维护 Relay 的协作、实现约束与验证要求。

## Stack

- Rust 1.94+（edition 2024）
- Tokio
- Axum / tokio-tungstenite
- Serde / serde_json
- tracing / tracing-subscriber
- Ed25519 challenge-response

## 常用命令

```bash
cargo build
cargo build --release
cargo run
RUST_LOG=info cargo run
cargo fmt -- --check
cargo clippy --locked -- -D warnings
cargo test --locked
```

## Protocol 规则

- 连接必须发送 `protocol_version=2` 的 role-aware Host/Owner hello，并完成 Ed25519 challenge-response。
- Host identity 是 canonical `device_id`；Owner identity 是 canonical `owner_id`。
- 相同 `(device_id, endpoint_id)` 只有一个权威 runtime；新 runtime takeover 后旧 connection/frame stale。
- Owner discovery 只能返回 Host 当前 ACL 包含该 Owner 的 endpoint。
- Owner→Host route 禁止自带 source/target Owner；Relay 注入认证连接的 canonical `source_owner_id`。
- Host→Owner route 必须携带 `target_owner_id`，且禁止 `source_owner_id`。
- `purpose=pairing` 只允许 QR pairing exchange；`purpose=session` 必须命中当前 Host ACL。
- `ct` 始终 opaque：不得 decode、parse、log 或 persist。
- Strict schema 拒绝未知字段、错误方向、错误 UUID/key 和旧 room frame；不得增加 compatibility fallback。

## 状态与持久化

- Endpoint registry、ACL、subscriptions 和 connection senders 全在内存中。
- Relay restart 后状态清空，由 Host/Owner reconnect 重建。
- 不添加数据库、membership storage、endpoint inventory、offline queue 或 traffic persistence。
- `/` 是 WebSocket upgrade；`/health` 是 liveness。

## 安全与日志

- 不记录 `ct`、消息正文、private key、signature、pairing token 或完整 public key。
- 可以记录 role、结果枚举和脱敏 connection metadata。
- 使用 `tracing`，不要使用 `println!`。
- 生产路径不使用 `.unwrap()` / `.expect()`；序列化等静态不可失败路径沿现有例外处理。
- 所有 async 工作使用 Tokio；不要用 `std::thread`。
- 不引入无界持久缓存；内存结构需有明确所有权和 stale cleanup。

## 不要做

- 不恢复 `/mesh`、room、presence、Pi forwarding 或 SQLite volume。
- 不解析 inner Protocol v2 来做业务授权；Relay 只依据 outer role、endpoint/runtime 和 ACL。
- 不把 pairing route 当成 session 授权。
- 不提交 `target/`。
