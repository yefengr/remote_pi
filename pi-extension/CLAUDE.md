# Remote Pi — Pi Extension（Node + TypeScript）

Remote Pi 的 Pi package：注册 `/remote-pi`，把当前 Pi 进程作为独立 endpoint 连接 Relay，并提供 Browser/PWA pairing、Protocol v2 timeline/actions 和可选 daemon supervisor。

当前身份层级是：

```text
device_id → endpoint_id → runtime_instance_id → session_id / history_generation
```

本项目不提供 Agent Mesh、本地 broker、Pi-to-Pi 通信、room routing、membership、mesh tools 或 MCP mesh server。协议、安全边界与跨端契约见 [`../PROTOCOL.md`](../PROTOCOL.md) 和 [`../.orchestration/contracts/`](../.orchestration/contracts/)。

## Stack

- Node 20+ / TypeScript 6
- ESM only（NodeNext）；TypeScript import 也必须带 `.js`
- pnpm（不要使用 npm/yarn）
- Pi SDK types/test contract：`@earendil-works/pi-coding-agent`（peer + dev；生产包不私有安装 SDK）
- Relay transport：`ws`
- Host identity：`@napi-rs/keyring` + headless file fallback
- Schema：TypeBox / Zod（沿现有模块边界）

## 常用命令

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` 必须在 Extension 行为变更后通过。生产 TypeScript 文件不超过 600 行。

## Relay 配置

优先级：

1. `REMOTE_PI_RELAY`
2. `~/.pi/remote/config.json`
3. 项目默认 Relay URL

用户输入使用 `http://` 或 `https://`；Extension 打开 WebSocket 时转换为 `ws://` 或 `wss://`。

相关命令：

- `/remote-pi set-relay <url>`
- `/remote-pi config`
- `/remote-pi pair`
- `/remote-pi devices`
- `/remote-pi revoke <shortid>`

## Endpoint 与 pairing 规则

- `device_id` 是 Host Ed25519 public key 的 canonical Base64 表示。
- interactive Pi 每个进程生成 endpoint/runtime；daemon endpoint 使用 registry UUID，child 每次 spawn 生成新 runtime。
- QR 必须包含 endpoint/runtime；不得恢复 room hint 或旧 QR fallback。
- Owner→Host sender 只能使用 Relay 注入的 `source_owner_id`。
- Pairing 成功或撤销后，必须同步 `endpoint_update.authorized_owner_ids`。
- Relay 断线只进入 reconnecting/degraded，不通过重启 Pi 修复。

## Daemon 规则

- Registry v2 使用 canonical cwd、稳定 UUID、`desired_state` 和 `created_at`。
- Supervisor 只恢复 `desired_state=running`，并清理 cwd 不存在的 stale entry。
- Pi settings/package discovery 是 Remote Pi Extension 的唯一来源；child 不传 `-e`。
- Supervisor 不导入或运行私有 Pi SDK；实际宿主 `pi --mode rpc` 负责 settings/package/resource discovery 和 diagnostics。
- Runtime ready 必须同时通过宿主 Pi RPC `get_state` 和 Extension `runtime-ready`，并核对 control protocol、endpoint/runtime identity；RPC ready 但 Extension 未 ready 时确定性进入 `extension_not_ready` blocked。
- Cron 只能在 desired/readiness/health 门禁通过时发送；没有 wake 路径。
- `unregister_cwd`/`remove-cwd` 必须幂等停止并删除 entry。

## 编码约定

- Strict TypeScript；优先 `unknown` + narrow，不使用无约束 `any`。
- ESM import：`import { foo } from "./bar.js"`。
- Boundary 严格校验；未知字段、旧版本、错误 route purpose 和 stale runtime fail closed。
- 确定性错误使用结构化 code/stage/retryable，不解析 stderr 推断状态。
- 不记录 private key、pairing token、完整 `ct` 或消息正文。
- 不自行实现 crypto primitive。
- 不提交 `dist/`。

## 编排模式

收到 `[ORCH:<task-id>]` 时，先完整阅读 `../.orchestration/INSTRUCTIONS.md`，遵守白名单、结果文件、验证和不提交约束。
