# Remote Pi — PWA（Next.js）

浏览器 PWA 子项目。唯一产品路由是 `/app`；`/` 使用服务端重定向进入 `/app`，同时保留根路径 Docker healthcheck。

## 技术栈与入口

- Next.js App Router、React、TypeScript；版本与 Node 兼容范围以 [`package.json`](package.json) 和锁文件为准。
- Mantine core/hooks 提供基础组件与交互能力；Tailwind 和业务 CSS 承担布局、响应式及项目样式。
- Dexie 管理 IndexedDB；Serwist 与 Next.js 构建集成；ZXing 用于二维码扫描，react-markdown/remark-gfm 用于消息展示。
- Vitest 分 Node 与 Browser Mode；Playwright 承担跨模块 E2E。
- 包管理器使用 **pnpm**；原生依赖的 `allowBuilds` 以 `pnpm-workspace.yaml` 为准，不另用 npm/yarn 生成锁文件。

主要入口：

- 产品路由：`src/app/app/`；业务组件：`src/components/pwa/`；浏览器业务运行态与存储：`src/lib/pwa/`。
- 协议与传输适配：`src/lib/remote-pi/`；薄 UI wrapper：`src/components/ui/`；Mantine theme：`src/lib/ui/remote-pi-theme.ts`。
- 当前状态所有权见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)，设计与组件边界见 [`../docs/DESIGN.md`](../docs/DESIGN.md)；本文件不重复维护架构正文或 token 表。

## 常用命令

在 `pwa/` 中执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 启动开发服务，默认端口 3000 |
| `pnpm build` | 同步安装脚本静态资源并生成生产构建 |
| `pnpm start` | 启动生产服务 |
| `pnpm lint` | ESLint |
| `pnpm test:unit` | Vitest Node 测试 |
| `pnpm test:component` | Vitest Browser Mode 组件测试 |
| `pnpm test` | 串行执行 Node 与 Browser Mode |
| `pnpm test:coverage` | 覆盖率报告 |
| `pnpm test:e2e` | Playwright E2E |

命令入口以 `package.json` 为准，测试项目和运行环境分别见 [`vitest.config.ts`](vitest.config.ts)、[`playwright.config.ts`](playwright.config.ts)。不要把文档中的历史测试数量当成当前验证结果。

## 编码与组件约定

- Server Components 为默认；需要 state、event、hook 或浏览器 API 时才使用 `"use client"`。核心 `PwaApp` 是客户端应用，这不授权增加服务端业务能力。
- 组件 props 明确类型，不使用 `any`。
- 优先复用现有薄 wrapper；已有业务组件直接使用 Mantine 并不等于需要再封装一层。视觉与样式分工遵循 [`../docs/DESIGN.md`](../docs/DESIGN.md)，不以旧 Tailwind-only 描述忽略现有 Mantine。
- 保留 Tailwind 与业务 CSS 的现有组织方式；不擅自引入 CSS Modules 或 styled-components。
- 图片在适用时使用 `next/image` 及静态 fallback；浏览器 data URL 附件按实际消费者处理，不为形式统一改写。
- 涉及 Modal、Drawer、Menu、Popover 的调整必须核对 Portal、焦点返回、Escape 竞争、滚动和叠层关系；按项目 overlay 验证技能验收，不仅比较截图。

## 范围与限制

- 不恢复 landing page、公开文档、教程或法律页面；产品界面仅位于 `/app`。
- 不未经授权添加 backend、API routes、账号或其他服务端业务入口。
- 不把历史 room/mesh 模型或尚未实施的主题原型当作当前实现规范；协议与安全边界引用 [协议与安全总览](../docs/reference/protocol/README.md)。
- 不提交 `.next/`、`out/`、`node_modules/` 等生成物；不通过禁用 lint 或修改生成物规避错误。
- 可以直接在当前分支开发；保留用户既有未提交改动，不自动提交、push 或发布。

## 验证与交付

- PWA 行为变更：执行 `pnpm lint` 和受影响的 Node/Browser Mode 测试。
- 生产 bundle 受影响时执行 `pnpm build`；关键跨模块流程增加相关 Playwright 场景。
- 独立 UI/Mantine 迁移批次遵循项目 UI 批次交付技能，涉及叠层时同时使用 overlay 验证技能。
- 纯文档变更只核对事实、引用、授权范围和 `git diff --check`，不据此运行或宣称通过业务测试。
- 真实移动设备能力不能用桌面 Chromium 的移动 viewport 代替；尚未结束的设备验收见 [`PWA 加固验收方案`](../docs/plans/active/20260824-pwa-hardening.md)。
- 最终执行受影响验证和 `git diff --check`；只扩展到实际受影响的范围。

## 发布

部署与运维事实统一维护在 [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。发布、推送和部署需要各自授权，本文件不复制部署步骤。
