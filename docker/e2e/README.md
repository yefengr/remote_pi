# Remote Pi Docker Protocol v2 E2E

这套基础设施只验证 **Relay-only Protocol v2**，不启动 `site/`，也不使用浏览器 profile、宿主 `~/.pi`、宿主 `node_modules` 或模型凭据。浏览器/PWA 场景应在后续独立批次叠加。

## 固定资源与隔离

Compose project 固定为 `remote-pi-e2e`，所有容器、网络和命名卷均带 `remote-pi-e2e-` 前缀：

- `remote-pi-e2e-relay`：由当前仓库的 `relay/Dockerfile` 构建；不映射宿主端口。
- `remote-pi-e2e-interactive`：Linux Node 24，容器内安装 `@earendil-works/pi-coding-agent@0.84.4`，容器内安装、构建当前 `pi-extension`；持久化 HOME、Pi config/session、workspace。
- `remote-pi-e2e-supervisor`：同一 Host 镜像，持久化独立 HOME、Pi config/session、workspace；运行实际 `pi-supervisord`。
- `remote-pi-e2e-owner-b` 与 `remote-pi-e2e-owner-c`：独立、常驻的 Protocol Owner；各自拥有持久 identity/state volume。

三张 `internal` 数据面网络分别为 `remote-pi-e2e-relay-host`、`remote-pi-e2e-relay-owner-b`、`remote-pi-e2e-relay-owner-c`。interactive 与两个 Owner 各自只接入一张数据面网络，Relay 是唯一同时接入三张网络的 Remote Pi 路由节点。

Docker runtime 不允许只连接 `internal` 网络的容器实际发布宿主端口，因此另设三个彼此独立、非 `internal` 的 host-control plumbing 网络：`remote-pi-e2e-control-interactive`、`remote-pi-e2e-control-owner-b`、`remote-pi-e2e-control-owner-c`。每张控制网络只连接一个控制服务，不连接 Relay 或其他节点；它们仅支撑下列宿主 loopback 控制 API，绝不承载 Remote Pi route 流量。所有 route 仍只能经过三张 `internal` Relay 数据面网络。

| 端口 | 控制服务 | 独立控制网络 |
|---|---|---|
| `127.0.0.1:18787` | interactive control API | `remote-pi-e2e-control-interactive` |
| `127.0.0.1:18788` | owner-b control API | `remote-pi-e2e-control-owner-b` |
| `127.0.0.1:18789` | owner-c control API | `remote-pi-e2e-control-owner-c` |

## 生命周期

```sh
./docker/e2e/scripts/up.sh             # 幂等构建并启动，保留已有 volumes
./docker/e2e/scripts/verify.sh         # 启动（如必要）并运行协议矩阵，不销毁状态
./docker/e2e/scripts/status.sh          # 输出脱敏状态
./docker/e2e/scripts/stop.sh            # 停止容器，保留全部 volumes
./docker/e2e/scripts/reset.sh           # 明确删除仅此 project 的容器/网络/volumes
```

脚本对 Docker CLI 与 Compose v2 缺失 fail fast。`reset.sh` 从不调用 `docker system prune` 或任何宽泛清理。

## 自动化矩阵

`verify.sh` 使用容器内当前仓库构建产物，且在没有模型凭据时运行。它只打印短指纹、计数、布尔断言和非敏感 ID，绝不输出 URI、配对 token、私钥、完整 public key、`ct` 或消息正文。

- Relay `/health`、Pi RPC `get_state`、Extension `runtime-ready`、relay connection；
- owner-b pairing、`session_ready`、`ping`/`pong`；
- owner-c 第二 pairing 和独立 session channel；
- `/new` 产生 `action_ok` 的 session replacement invariant；
- revoke 后 `endpoint_ended`、被撤销 Owner 路由拒绝、存活 Owner ping；
- `peer_stop` bye、interactive restart readness；
- supervisor UDS 和 cron `desired_state=stopped` gate。

当前产品实现的 revoke 路径会 detach 绑定并撤销 ACL，但不向被撤销 Owner 主动发送 `bye(peer_stop)`；验证将其明确写为 `expected_known_failure`，而不修改产品源码。ACL/`endpoint_ended`/route rejection/survivor ping 仍必须通过。
