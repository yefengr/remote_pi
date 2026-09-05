# Remote Pi 自托管部署

本文记录从本机发布 Relay/PWA 到远程 Linux 服务器的可重复流程。部署分为两个明确阶段：

```text
test
  本机构建 -> SSH 传输 -> 仅启动测试 PWA（127.0.0.1:3002）
  -> 人工复核 remote-pi-test.*

promote
  复用已传输镜像 -> 启动生产 Relay/PWA
```

默认不推送 Docker Hub；镜像传输和服务器启动不要求服务器从镜像仓库拉取应用镜像。本机 Buildx 构建仍需能够取得 Dockerfile 使用的基础镜像和构建依赖。Caddy 只在首次初始化或域名/端口变化时调整，普通版本部署不修改 Caddy。

这是已有环境的版本发布流程，不是空服务器的一键初始化流程：`test` 要求现有生产 Relay 已经 `healthy`，不会替你首次启动 Relay；首次初始化需要单独确认范围。系统职责和数据边界见 [ARCHITECTURE](ARCHITECTURE.md)，部署步骤以本文件及下列脚本、配置为准。

## 文件职责

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `docker-compose.yml` | Relay、测试 PWA、生产 PWA 的运行编排 | 是 |
| `deploy.env.example` | 部署变量模板，不含真实值 | 是 |
| `deploy.env` | 本机真实 SSH/服务器配置 | 否，已加入 `.gitignore` |
| `scripts/deploy-self-hosted.sh` | `test` / `promote` 两阶段部署和验收 | 是 |
| `/etc/caddy/Caddyfile` | 服务器 HTTPS 与反向代理 | 服务器 root 配置，不由部署脚本修改 |

`deploy.env` 不得保存私钥、服务器密码或 Docker Hub Token。SSH 私钥由本机 SSH 客户端和 `~/.ssh/config` 管理；需要 Docker Hub 登录时，在交互式终端中单独执行 `docker login`。

## 一次性准备

### 本机

要求：

- Docker Engine/OrbStack/Docker Desktop；
- Docker Buildx；
- `ssh`、`scp`、`gzip`、`curl`；
- SSH 别名已经写入本机 `~/.ssh/config`；
- SSH 登录账号能够直接运行 `docker` 和 `docker-compose`。

创建本机配置：

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env
chmod 600 deploy.env
```

最小配置示例（使用占位符，不要直接照抄真实信息；版本仅为示例，发布时使用本次核验的镜像标签）：

```dotenv
DEPLOY_SSH=your-ssh-alias
DEPLOY_USER=your-deploy-user
REMOTE_DIR=/home/your-deploy-user/remote-pi
IMAGE_NAMESPACE=remote-pi-local
RELAY_VERSION=v0.3.1
SITE_VERSION=v0.1.0
PUBLISH_IMAGES=0
TEST_PWA_URL=https://pwa-test.example.com/app
PWA_URL=https://pwa.example.com/app
RELAY_URL=https://relay.example.com
KEEP_IMAGE_ARCHIVE=0
```

先验证 SSH：

```bash
ssh "$DEPLOY_USER@$DEPLOY_SSH" \
  'uname -m && docker info --format "Server={{.ServerVersion}}" && docker-compose version'
```

服务器必须是 `x86_64/amd64` 或 `aarch64/arm64`。部署账号需要能够执行：

```bash
docker info
docker-compose version
docker load
docker-compose up -d
```

### 服务器

服务器部署目录可以提前创建：

```bash
mkdir -p /home/your-deploy-user/remote-pi
```

服务器使用 rootful Docker 时，部署账号通常加入 Docker 用户组。该权限接近 root，只应授予专用部署账号：

```bash
sudo groupadd --system docker  # 已存在时忽略错误
sudo usermod -aG docker your-deploy-user
```

重新登录后验证：

```bash
id
docker info
docker-compose version
```

服务器不需要安装 Caddy 才能运行容器；Caddy 是宿主机上的一次性 HTTPS 入口。

## 两阶段部署

### 阶段一：部署测试 PWA

每次发布从 `test` 开始：

```bash
./scripts/deploy-self-hosted.sh test
```

脚本会：

1. 读取未提交的 `deploy.env`；
2. 通过 SSH 查询服务器架构并检查 Docker/Compose；
3. 检查当前生产 Relay 是否 `healthy`；
4. 用 Buildx 构建服务器对应架构的 Relay 和 PWA 镜像；
5. 可选推送远程镜像（默认关闭）；
6. 上传 `docker-compose.yml`；
7. 将两个本地镜像压缩后通过 SSH 流式传输；
8. 在服务器执行 `docker load`；
9. 只启动 `site-test`，映射 `127.0.0.1:3002`；
10. 等待测试容器变为 `healthy`；
11. 检查 `TEST_PWA_URL` 和现有 Relay URL。

测试阶段**不会启动或替换生产 Relay/PWA**。测试 PWA 复用当前生产 Relay，可验证连接认证、配对和消息链路；Remote Pi 没有账号登录服务。此阶段虽然构建并传输了新的 Relay 镜像，却没有运行它，因此不能据此宣称新 Relay 行为已通过联调；需要验证 Relay 变更时，应另行确认隔离环境和测试数据范围。

你的 Caddy 测试路由示例：

```caddyfile
remote-pi-test.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3002
}
```

实际域名写入本机未提交的 `deploy.env`：

```dotenv
TEST_PWA_URL=https://remote-pi-test.example.com/app
```

Caddy 修改后只需执行一次：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

然后人工打开测试地址复核。建议至少检查：

- 页面资源和静态文件正常；
- PWA 设置中的 Relay URL 正确；
- 新二维码扫描或粘贴配对流程；
- device/endpoint 列表、当前 endpoint 选择和连接状态；
- 发送消息、接收输出、刷新页面后的本地历史；
- 浏览器 Console 和 Relay 日志无异常。

服务器查看测试容器：

```bash
cd /home/your-deploy-user/remote-pi
docker-compose --profile test ps site-test
docker-compose --profile test logs --tail=100 site-test
curl -I http://127.0.0.1:3002/app
```

测试容器默认保留，不影响生产端口。人工确认失败时，修复代码后递增 `SITE_VERSION`/`RELAY_VERSION`，重新执行 `test`。不要直接执行 `promote`。

### 阶段二：人工确认后发布生产

确认测试环境后，执行：

```bash
./scripts/deploy-self-hosted.sh promote
```

`promote` 不会重新构建、不访问 Docker Hub、也不会重新上传镜像。它会：

1. 确认测试阶段传输的两个镜像仍在服务器；
2. 启动或更新生产 `relay`（`127.0.0.1:3000`）；
3. 启动或更新生产 `site`（`127.0.0.1:3001`）；
4. 等待两个生产容器健康；
5. 检查生产 Relay 和 PWA URL。

测试 PWA 会继续运行在 `127.0.0.1:3002`，便于回溯和对比。测试阶段还会在远程部署目录写入 `.remote-pi-test-state`，仅保存已测试镜像引用和镜像 ID，供 `promote` 做一致性校验。若确认后希望停止测试容器：

```bash
docker-compose --profile test stop site-test
```

停止测试容器不会影响生产 Relay/PWA。

`promote` 会核对 `.remote-pi-test-state` 中的镜像引用和镜像 ID，但不执行自动回滚。若更新部分服务后健康检查失败，应先核对实际容器状态并单独确认恢复方案，不把脚本退出失败理解为生产环境已自动恢复。

## 镜像模式

### 默认：本地构建并传输

```dotenv
PUBLISH_IMAGES=0
```

镜像只在本机 Buildx 和服务器 Docker 中存在，标签由 `IMAGE_NAMESPACE`、`RELAY_VERSION` 和 `SITE_VERSION` 组成。服务器 Compose 使用脚本注入的 `RELAY_IMAGE`、`SITE_IMAGE`，不会把本机命名空间写入仓库文件。

如服务器是 `x86_64`，脚本相当于构建：

```bash
docker buildx build --platform linux/amd64 --load \
  --tag remote-pi-local/remote-pi-site:v0.1.0 pwa

docker buildx build --platform linux/amd64 --load \
  --tag remote-pi-local/remote-pi-relay:v0.3.1 relay
```

随后执行等价的流式传输：

```bash
docker save \
  remote-pi-local/remote-pi-relay:v0.3.1 \
  remote-pi-local/remote-pi-site:v0.1.0 \
  | gzip \
  | ssh your-deploy-user@your-ssh-alias 'gzip -dc | docker load'
```

服务器启动时使用：

```bash
docker-compose up -d --pull never
```

### 可选：同时推送远程镜像

只有明确需要给其他机器拉取镜像时才开启：

```dotenv
IMAGE_NAMESPACE=your-dockerhub-user
PUBLISH_IMAGES=1
```

先确保本机已经登录目标仓库：

```bash
docker login
```

此模式会额外执行 Buildx `--push`。它推送当前服务器架构的镜像；多架构公共发布仍可单独使用：

```bash
IMAGE=your-dockerhub-user/remote-pi-site ./pwa/push-docker.sh v0.1.0
IMAGE=your-dockerhub-user/remote-pi-relay ./relay/push-docker.sh
```

不要把 Token 写入 `deploy.env`、脚本、Compose 或 Git。

## Compose 运行结构

当前 Compose 包含三个服务：

```text
Relay:      127.0.0.1:3000 -> 容器 3000
PWA test:   127.0.0.1:3002 -> 容器 3000（profile: test）
PWA prod:   127.0.0.1:3001 -> 容器 3000
```

当前 [Compose](../docker-compose.yml) 没有 Relay 数据卷或 SQLite membership 存储。Relay 的 endpoint registry 和 ACL 仅保存在内存中，重启后由 Host/Owner 重连重建；旧环境是否残留历史 volume 不在本流程中自动清理。PWA 不保存服务端业务会话数据，浏览器本地使用 IndexedDB；Host 身份、配对和 Pi 会话保存在运行 Pi 的电脑上，而不是这些 Relay/PWA 容器中。

源码子项目已名为 `pwa/`，但 Compose 服务 `site` / `site-test`、镜像名 `remote-pi-site` 和变量 `SITE_VERSION` / `SITE_IMAGE` 仍是当前脚本使用的名称；执行部署命令时不要仅按目录新名称替换它们。

服务器上查看状态：

```bash
cd /home/your-deploy-user/remote-pi
docker-compose ps
docker-compose --profile test ps
docker-compose logs --tail=100 relay site site-test
```

本机健康检查：

```bash
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
curl -I http://127.0.0.1:3002/app
```

## Caddy 一次性配置

普通版本部署不修改 Caddy。只有首次部署、域名变化或容器端口变化时才需要调整。

假设使用三个域名：

```text
pwa.example.com
pwa-test.example.com
relay.example.com
```

DNS 都指向服务器公网 IP，并在云厂商安全组/防火墙开放 TCP `80` 和 `443`。不要把 `3000`、`3001`、`3002` 暴露到公网。

Caddyfile 追加：

```caddyfile
pwa-test.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3002
}

pwa.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}

relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

应用配置前先检查：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请和续期公开 HTTPS 证书，并自动转发 Relay 的 WebSocket Upgrade。客户端使用 HTTPS Relay URL：

```text
PWA Relay URL: https://relay.example.com
Pi extension:  https://relay.example.com
```

测试 PWA 和生产 PWA 复用同一 Relay 时，二者使用同一个 Relay URL。测试应使用获准的隔离 Pi 身份、endpoint 和浏览器数据，避免影响生产配对与会话；只换一个 endpoint 或网页域名并不隔离同一 Host identity 下的 device-scoped 配对与撤销。

## 配对检查

二维码当前不携带 Relay 地址。切换到自建 Relay 后，必须在 PWA 设置中保存：

```text
https://relay.example.com
```

然后在 Pi 重新生成二维码：

```text
/remote-pi pair
```

配对超时时，先确认 PWA 和 Pi 使用同一个 Relay。服务器查看 Relay 日志：

```bash
docker-compose logs -f relay
```

一次成功的配对应能看到 Pi 和浏览器两条认证连接。二维码或复制代码包含一次性凭据，不要写入文档、日志、Issue 或聊天记录。

## 发布脚本

`pwa/push-docker.sh` 和 `relay/push-docker.sh` 支持通过 `IMAGE` 覆盖镜像名：

```bash
IMAGE=your-dockerhub-user/remote-pi-site ./pwa/push-docker.sh v0.1.0
IMAGE=your-dockerhub-user/remote-pi-relay ./relay/push-docker.sh
```

不传 `IMAGE` 时使用 `REGISTRY_NAMESPACE`，再没有时使用本地占位命名空间。日常服务器部署不需要调用这两个发布脚本，直接按 `test` -> 人工复核 -> `promote` 执行即可。

## 故障排查

### `docker compose` 不存在

服务器可能安装的是独立命令：

```bash
docker-compose version
```

部署脚本使用 `docker-compose`，与当前服务器环境一致。

### Docker Hub 超时

先区分失败发生在本机基础镜像/依赖获取、可选镜像推送，还是 SSH 镜像传输。`PUBLISH_IMAGES=0` 只关闭应用镜像推送，不消除本机构建对基础镜像和依赖源的需求；服务器接收的是本机传输的镜像，不需要从 Docker Hub 拉取这些应用镜像。

### `promote` 找不到镜像

必须先对当前版本执行：

```bash
./scripts/deploy-self-hosted.sh test
```

如果测试期间修改了版本变量，`promote` 会拒绝执行。恢复到测试阶段使用的版本，或重新执行 `test`。

### 测试 PWA 无法启动

```bash
docker-compose --profile test ps site-test
docker-compose --profile test logs --tail=200 site-test
curl -I http://127.0.0.1:3002/app
```

确认 Caddy 测试站点反代到 `127.0.0.1:3002`，而不是生产端口 `3001`。

### 容器不是 healthy

```bash
docker-compose ps
docker-compose --profile test ps
docker-compose logs --tail=200 relay site site-test
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
curl -I http://127.0.0.1:3002/app
```

### HTTPS 失败

确认：

- DNS A/AAAA 记录指向服务器；
- TCP `80/443` 已开放；
- Caddyfile 校验通过；
- 容器本机端口正常；
- Caddy 服务状态为 `active`。

```bash
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

不要为了绕过证书问题把客户端改成公网 `ws://`，生产环境必须使用 HTTPS/WSS。

## 安全边界

部署脚本不会：

- 读取、上传或修改 SSH 私钥；
- 读取或保存服务器密码、Docker Hub Token；
- 修改 `/etc/caddy/Caddyfile`；
- 重启 Docker daemon；
- 停止无关容器；
- 执行 `docker system prune`；
- 在默认模式下向 Docker Hub 推送应用镜像，或要求服务器拉取这些应用镜像。
