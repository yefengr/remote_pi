# Remote Pi — Monorepo

本仓库是 Remote Pi monorepo。当前 Agent 可以直接在当前 Git 分支修改已授权的子项目代码，并在对应子项目目录运行验证。

## 项目结构

| 目录 | 技术栈 | 职责 |
|---|---|---|
| `pi-extension/` | Node + TypeScript | Pi 扩展、Daemon、Agent Mesh 与远程会话协议 |
| `relay/` | Rust + Tokio | WebSocket Relay、Rooms 与跨 PC Agent Mesh 路由 |
| `pwa/` | NextJS + React + TypeScript | 浏览器 PWA；唯一产品路由为 `/app`，根路径 `/` 重定向至该路由 |

## 工作规则

- 修改前先读取目标子项目的 `CLAUDE.md`、相关代码、测试和配置。
- 只修改用户明确授权的范围；不自动扩大到无关子项目或文档。
- 当前分支可以直接开发，不要求使用特定终端、pane、worktree 或外部编排工具。
- 构建、测试和 lint 在对应子项目目录执行，例如 `cd pwa && pnpm lint`。
- 行为变更必须提供适当的自动化验证；最终执行受影响验证和 `git diff --check`。
- 不自动执行 `git commit`、`git push`、Pull Request、生产发布或其他外部副作用，除非用户明确授权。
- 发现现有未提交改动时，保留并基于当前工作区继续，不回退用户改动。
- 涉及架构、协议、配对、UI 或安全方向时，先阅读 `plan/00-decisions.md`，不要静默推翻已关闭决策。
- 实施、验证、审查、提交或部署独立 PWA UI/Mantine 迁移批次时，加载项目技能 `remote-pi-pwa-ui-batch-delivery`。
- PWA 任务涉及 Modal、Drawer、Menu、Popover、Portal、焦点或层级时，同时加载项目技能 `validate-mantine-stacked-overlays`。

## 计划与文档

根目录的 `plan/` 用于架构计划、决策和跨子项目协调。计划描述目标、实现边界和验证方式；正式实现直接落在对应子项目。

项目长期文档按仓库现有目录规范维护。不要为一次性任务创建无恢复价值的长期文档。

## 常用验证

```bash
cd pwa && pnpm lint
cd pwa && pnpm build
cd pi-extension && pnpm test
cd relay && cargo test
```

只运行与当前变更相关的命令；跨项目共享协议或部署配置变更时扩大验证范围。

## 发布

发布、推送和部署必须在本地验证通过后按用户授权执行。PWA 的 Docker 发布和测试环境部署说明以 `pwa/CLAUDE.md`、`pwa/push-docker.sh` 和 `scripts/deploy-self-hosted.sh` 为准。

## 已关闭决策

`plan/00-decisions.md` 是已关闭的产品与架构决策记录。提出方向变化前必须先核对该文件，并在需要时显式说明证据和影响。
