<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi 标识" />
</p>

<h1 align="center">Remote Pi</h1>

通过浏览器远程控制 Pi coding agent：扫码配对、选择运行入口、发送消息并查看输出。

## 快速开始

在已安装 Pi 的电脑上安装扩展：

```bash
pi install npm:@yefengr/remote-pi
```

然后在 Pi 中执行：

```text
/remote-pi
/remote-pi pair
```

打开已部署 PWA 的 `/app` 页面，确认 PWA 与 Pi 使用同一个 Relay，扫描二维码后选择端点（endpoint），即可发送消息。每台电脑需要单独配对。

可选的后台进程管理见 [Daemon 使用指南](pi-extension/docs/daemon.md)。

> 当前没有应用层端到端加密；敏感场景请使用可信 Relay。详见[协议与安全说明](PROTOCOL.md)。

## 项目结构

| 子项目 | 技术栈 | 职责 |
| --- | --- | --- |
| [pi-extension/](pi-extension/) | Node + TypeScript | Pi 扩展、配对、远程会话与 Daemon 管理 |
| [relay/](relay/) | Rust + Tokio | WebSocket 认证、端点注册与消息路由 |
| [pwa/](pwa/) | Next.js + React | 浏览器控制界面与本地数据存储 |

## 文档导航

| 内容 | 文档 |
| --- | --- |
| 产品背景与术语 | [CONTEXT](docs/CONTEXT.md) |
| 当前架构与状态所有权 | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 设计系统与组件规则 | [DESIGN](docs/DESIGN.md) |
| 协议与安全边界 | [PROTOCOL](PROTOCOL.md) |
| 自托管部署 | [DEPLOYMENT](docs/DEPLOYMENT.md) |
| 已确定事项与进度 | [ROADMAP](docs/ROADMAP.md) |
| 尚未确定开发的建议 | [BACKLOG](docs/BACKLOG.md) |
| 协作、命令与验证 | [AGENTS](AGENTS.md) |

## 许可证

[MIT License](LICENSE)。
