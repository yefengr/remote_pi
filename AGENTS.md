# Remote Pi — Monorepo

本仓库是 Remote Pi monorepo。当前主要使用 Pi coding agent 协作；Pi 的主 Agent、`subagent` 和项目 skills 是默认工作流。

## 项目结构

| 目录 | 技术栈 | 职责 |
|---|---|---|
| `pi-extension/` | Node + TypeScript | Pi 扩展、Daemon、配对与远程会话协议 |
| `relay/` | Rust + Tokio | WebSocket Relay、endpoint registry 与 ACL 路由 |
| `pwa/` | NextJS + React + TypeScript | 浏览器 PWA；唯一产品路由为 `/app`，根路径 `/` 重定向至该路由 |

## 工作规则

- 修改前先读取目标子项目的 `AGENTS.md`、相关代码、测试和配置。
- 只修改用户明确授权的范围；不自动扩大到无关子项目或文档。
- 当前分支可以直接开发，不要求使用特定终端、pane、worktree 或外部编排工具。
- 构建、测试和 lint 在对应子项目目录执行，例如 `cd pwa && pnpm lint`。
- 行为变更必须提供适当的自动化验证；最终执行受影响验证和 `git diff --check`。
- 不自动执行 `git commit`、`git push`、Pull Request、生产发布或其他外部副作用，除非用户明确授权。
- 发现现有未提交改动时，保留并基于当前工作区继续，不回退用户改动。
- 涉及架构、协议、配对、UI 或安全方向时，先阅读 `plan/00-decisions.md`，不要静默推翻已关闭决策。
- 独立 PWA UI/Mantine 迁移批次按项目技能执行；涉及叠层、焦点或 Portal 时同时执行对应的 overlay 验证技能。

## 文档职责

- `README.md` 是项目入口；`AGENTS.md` 只记录协作、命令、范围和验证规范。
- `PROTOCOL.md` 是产品与安全边界概览；完整的 Protocol v2 与配对契约位于 `docs/reference/protocol/`。
- `docs/` 保存稳定架构、部署、设计和参考事实；`docs/reference/protocol/fixtures/` 保存跨端测试共用的机器样例。
- `plan/` 保存历史方案和仍需审计的决策记录，不作为当前实现真源；一次性任务提示、探针结果和临时日志不迁入长期文档。
- `.pi/tmp/` 仅用于当前任务的临时截图、日志、证据和调试产物，不作为项目真源。
- 同一事实只保留一个权威落点；其他文档使用链接，不复制维护协议或状态。

## 常用验证

```bash
cd pwa && pnpm lint
cd pwa && pnpm build
cd pi-extension && pnpm test
cd relay && cargo test
```

只运行与当前变更相关的命令；跨项目共享协议或部署配置变更时扩大验证范围。

## 发布

发布、推送和部署必须在本地验证通过后按用户授权执行。PWA 的 Docker 发布和测试环境部署说明以 [`docs/deployment-self-hosted.md`](docs/deployment-self-hosted.md)、`pwa/push-docker.sh` 和 `scripts/deploy-self-hosted.sh` 为准。

## 已关闭决策

`plan/00-decisions.md` 是已关闭的产品与架构决策记录。提出方向变化前必须先核对该文件，并在需要时显式说明证据和影响。
