# 框架与组件使用规范调整方案

日期：2026-09-05

## 授权与范围

本次仅获授权记录调整方案，只新增本文件。这不代表现行规范或实现已经调整，也不代表后续开发已获授权。各阶段实施前仍需另行确认具体文件、行为与验证范围。

以下建议不取代现行 [AGENTS.md](../../../AGENTS.md)、子项目规范、协议或已关闭决策。若后续实施需要改变既有边界，应先提出独立方案并取得确认，不能以本文件作为直接修改依据。本方案不另设项目级事项状态；项目级状态以 [ROADMAP](../../ROADMAP.md) 为准。

本方案的非目标：

- 不更换框架、不新增状态管理库、不升级依赖。
- 不修改协议、存储契约、daemon 或 Relay 职责，不调整部署方式。
- 不修改品牌或布局视觉，不恢复官网与历史功能。
- 不自动执行提交、push 或发布。

## 当前判断

以下现状以 `3cafa39f3dd98234fba50d74a609bbbba681dcf6` 时的干净工作区为基线。后续实施前需复核受影响部分，不能把方案中的快照当作持续更新的实现清单。

Remote Pi 的唯一产品路由是 `/app`，`/` 在服务端重定向到 `/app`。Browser/PWA Owner 经 WebSocket/TLS 连接 Relay，再到 Pi endpoint。PWA 保存本地身份、配对、endpoint metadata 和 timeline；Relay 使用内存 registry/ACL，转发 opaque `ct`，不提供数据库或离线消息队列。

Pi Extension 通过宿主扩展机制接入，生产环境不私有安装 Pi SDK；supervisor 从实际 `pi --mode rpc` 宿主发现资源。产品与安全边界继续以 [PROTOCOL.md](../../../PROTOCOL.md) 和[完整协议参考](../../reference/protocol/)为准，本方案不重述协议字段或安全规则。

Next.js 当前承担路由、构建、静态资源、standalone 输出和 Serwist 集成，见 [next.config.ts](../../../pwa/next.config.ts)。核心界面是客户端 `PwaApp`，由 `pwa/src/app/app/page.tsx` 渲染。不能因为 Next.js 提供服务端能力就扩大产品边界；未经授权添加 backend/API routes 仍被 [PWA 规范](../../../pwa/AGENTS.md)禁止。

建议保留主栈，先收敛各层使用方式与文档职责。这里的匹配度判断用于确定调整方向，不是性能测试结论，也不是逐版本依赖审计。

| 技术范围 | 当前用途与匹配度 | 建议与边界 |
| --- | --- | --- |
| React / Next.js | React + TypeScript 承载交互；Next.js App Router 已接入构建和交付流程 | 保留现有职责，不为使用服务端能力新增产品功能 |
| Mantine core/hooks | 提供基础组件、交互行为和相关 hooks，适合当前应用界面 | 收敛组件使用规则，不把所有 Mantine API 再包装一层 |
| 样式 | Mantine、Tailwind、theme 与业务 CSS 共同承担界面样式 | 明确基础样式、统一值和布局的分工，避免重复定义 |
| Dexie | 服务于浏览器本地数据持久化 | 保留存储职责，本方案不修改存储契约 |
| Serwist | 已与 Next.js 构建集成，承担 PWA 缓存相关能力 | 保留集成，缓存能力不等于离线远程控制 |
| Pi Extension | Node + TypeScript、ws 与 Pi peer SDK，接入实际 Pi 宿主 | 保留宿主扩展和资源发现边界，不引入私有生产 SDK 安装 |
| Relay | Rust + Tokio + Axum，承担连接、registry/ACL 与转发 | 保留轻量路由职责，不增加数据库或离线消息队列 |
| 测试 | Node/Browser Vitest 与 Playwright，覆盖不同验证层次 | 按行为影响选择验证，不把全部测试设为每次修改的统一门禁 |

PWA 还使用 react-markdown/remark-gfm、ZXing、Lucide 和 Zod。它们不构成本次替换目标，也无需在方案中固化补丁版本或测试数量。

当前规范与实现之间存在表达差距：`pwa/AGENTS.md` 的 Stack 尚未列出 Mantine、Dexie、Serwist 和分层测试，样式约定仍强调 Tailwind utility-first。这说明规范需要核对与收敛，不表示可以立即绕过现行约束。

详细组件与测试取舍仍记录在已完成的[组件库迁移方案](../completed/20260828-ui-component-library-migration.md)、[自动化测试方案](../completed/20260830-pwa-automated-testing.md)和 [UI 质量路线](../completed/20260829-pwa-ui-quality-roadmap.md)中。方案文档保留历史背景和决策原因，不作为当前实现真源。

## 职责调整建议

### 组件与样式

现有 `pwa/src/components/ui/` 已有 Button、IconButton、Input、Textarea、Select、Badge、Tooltip 等薄 wrapper；业务组件仍直接使用 Mantine Modal、Drawer、Menu、Popover 和部分布局原语。现有 wrapper 并未屏蔽全部库 API，也没有必要以此为目标。

建议按以下边界组织后续调整：

- Mantine 负责基础行为、可访问性和基础样式。
- Theme/token 负责颜色、字体、尺寸等统一值。
- Tailwind 与业务 CSS 负责布局、响应式和领域专有界面。
- Wrapper 只统一默认尺寸、语义和产品约束，不复制 overlay 行为。

`pwa/src/lib/ui/remote-pi-theme.ts` 已统一部分品牌色、字体和尺寸；`pwa/src/app/globals.css` 仍包含 token 与业务样式；`pwa/src/components/pwa/pwa-ui-provider.tsx` 管理 Provider。这些是现有组织方式，不代表 token 已完全统一。

后续应为重复使用的 token 确定单一权威定义，并建立 theme、CSS 与消费者之间的引用映射。同一颜色或尺寸不应作为两个独立事实在 theme/CSS 中并行维护；具体权威落点需在盘点现有消费者后确认。

不为形式统一包装所有组件，也不全量重写 CSS。是否增加 overlay 封装，应取决于是否存在真实、重复的产品策略，而不是仅因业务组件直接使用 Mantine。焦点、Escape、Portal 和滚动行为不能在薄 wrapper 中重复实现。

### 文档职责

建议将后续确认的规则分别落到以下位置；这些都是候选修改，本次不创建或修改其中任何文件：

| 文档 | 建议职责 |
| --- | --- |
| `AGENTS.md` 与子项目 `AGENTS.md` | 记录实际技术栈、入口、命令、协作约束和验收要求 |
| `docs/DESIGN.md` | 承载经确认的 token、组件与样式规则 |
| `docs/ARCHITECTURE.md` | 承载经确认的三端职责与状态所有权 |
| `README.md` | 提供项目入口和必要导航，不重复维护详细规则 |

当前 `docs/` 尚无 `DESIGN.md` 或 `ARCHITECTURE.md`。只有内容确有长期维护价值且获得明确授权时，才创建相应文档，不机械补齐空文件。

协议和部署继续引用现有真源，包括[协议参考](../../reference/protocol/)与[部署说明](../../DEPLOYMENT.md)，不复制维护。[历史文档索引](../../reference/legacy-plans.md)所指向的归档材料中，仍有效的约束需先核对，再迁入获准的长期落点；历史方案保留决策原因，不继续作为现行规则入口。

### 状态所有权

现有边界包括 `use-endpoint-registry`、`use-device-pairing`、`use-active-endpoint-selection`、`use-timeline-viewport` 和 timeline runtime/store。`PwaApp` 仍编排连接、session、timeline 与 UI。这里描述的是当前所有权分布，不据此认定实现存在缺陷。

后续只有出现具体维护问题时，才进一步区分 UI 临时状态、领域运行态和持久化职责，并判断是否需要局部抽取。组件行数、`useState` 数量或拆分文件数量，都不应单独成为重构理由。

## 分阶段实施与验收

阶段 A 先核对规范；阶段 B、C 只在证据支持且另行获准时开展，不是必须依次完成的重构清单。每个阶段开始前都应冻结范围，阶段结束后再决定是否需要继续。

### 阶段 A：规范收敛

先盘点实际依赖、组件与样式入口、状态边界，以及历史方案中仍有效的约束。确认每项事实的权威落点和已有消费者后，再提出精确的文档修改范围，取得授权后写入。

- 产物：获准更新的规范，以及确有内容需要承载的设计或架构文档。
- 验收：规范与当前实现一致；链接有效；同一规则没有重复真源；新旧文档不存在未处理的矛盾。
- 停止条件：历史约束与当前实现或已关闭决策冲突时，先交由维护者确认，不能自行选择其中一方。
- 无需修改条件：已有文档足以承载有效规则时只做必要更新；没有独立内容时不新建文档。

本阶段不顺带更改业务组件、协议、部署或状态实现。发现实现问题时应单独列明证据与建议范围，不能把文档授权延伸为代码授权。

### 阶段 B：局部统一组件和样式

只有具体消费者呈现重复默认值、重复产品约束或样式定义冲突时，才提出局部调整。每批开始前明确目标文件、保留行为和验证范围，保持品牌、交互、移动端表现与 `/app` 路由不变。

- 产物：与已确认规则对应的小批组件或样式调整，以及必要的回归验证。
- 验收：消费者采用明确的默认值和 token 来源；受影响交互、响应式及可访问性行为保持正确。
- 停止条件：调整需要改变既有视觉、交互、路由或跨模块契约时，暂停并重新确认范围。
- 无需修改条件：直接使用 Mantine 已满足需求且没有重复策略时，保留现状；没有重复事实时，不额外增加 wrapper 或 token 层。

涉及 Modal、Drawer、Popover 等叠层时，按实际行为执行 overlay 专项验证。不能以组件替换完成或静态截图一致代替焦点与键盘行为验收。

### 阶段 C：按维护问题澄清状态所有权

以具体维护问题为输入，说明连接、配对、时间线中的哪项职责不清，以及对消费者的实际影响。先澄清 UI 临时状态、领域运行态与持久化边界，再决定仅补充说明还是局部抽取。

- 产物：经确认的所有权说明；确有需要时附带获准的局部实现和对应测试。
- 验收：受影响状态的持有者与消费者职责明确，连接、session 和 timeline 的既有行为不变，相关恢复流程有适当验证。
- 停止条件：需要改变协议、存储契约、daemon 或 Relay 职责时，转为独立方案；不能借局部抽取扩大范围。
- 无需修改条件：当前边界已能清楚解释并维护行为时，保留实现；不默认引入 Redux、Zustand 或状态机库。

本阶段不以缩短 `PwaApp` 或增加模块数量为验收目标，也不要求推翻已经存在的 hooks 与 runtime/store 边界。

## 验证范围

本轮交付检查仅限文档事实、结构、相对链接、授权范围与 `git diff --check`。本方案不声称业务测试、构建或性能评估已运行或通过。

后续验证按实际影响选择，并遵循实施时的子项目规范：

| 变更类型 | 适用验证 |
| --- | --- |
| 纯文档 | 核对事实、链接、职责和授权范围，执行 `git diff --check`；不运行业务测试 |
| PWA 行为 | 在 `pwa/` 执行适用的 `pnpm test:unit`、`pnpm test:component`，并执行 `pnpm lint` |
| 生产 bundle 受影响 | 在 `pwa/` 执行 `pnpm build` |
| 关键跨模块或 UI 流程 | 在 `pwa/` 执行适用的 `pnpm test:e2e` 场景 |
| Overlay 行为 | 验证焦点、Escape、Portal、滚动及实际涉及的叠层交互 |
| 另行获准的 Extension 行为 | 依 [pi-extension/AGENTS.md](../../../pi-extension/AGENTS.md) 在对应目录执行 `pnpm verify` |
| 另行获准的 Relay 行为 | 依 [relay/AGENTS.md](../../../relay/AGENTS.md) 选择对应验证 |

上述验证不是本次扩大修改范围的许可，也不是每批调整必须全量执行的清单。真实移动端能力不能由 Chromium viewport 替代；涉及后台、恢复或设备能力的要求，应使用对应环境取证。

## 重新评估与停止条件

Next.js 的结构相对偏重，不等于运行性能慢。从零建设时 React + Vite 可以是更精简的候选，但当前项目没有经测量的迁移收益，本方案不启动框架迁移。

只有出现明确的构建、部署或维护瓶颈，取得可比较的基线，并计入 Serwist、standalone 和 E2E 的迁移成本后，才值得重新评估。评估结论需由独立方案确认，不能把框架偏好当作迁移依据。

PWA 适合打开后的交互与恢复。缓存不等于离线控制，也不能默认承诺手机后台不断线、原生级密钥保护或后台执行。若这些能力成为硬需求，应另做能力与安全评估，而不是借本方案迁移到原生应用。

当现有规则与实现已经足够清楚、没有消费者证据支持继续调整时，应在已完成的授权范围内收口。后续每项修改都应由实际问题、明确收益和独立授权驱动，不因本方案列有阶段而自动推进。
