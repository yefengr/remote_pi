# 计划 66 — Site UI 组件库引入与 PWA 迁移

**技术状态：Phase 0–4 的实现当前有效；Phase 3 已按新模型完成收口；Phase 5 尚未实施**
**当前核对：2026-09-01；当前执行状态、跨计划顺序和切换门禁以 [Plan 68 — PWA UI 与自动化测试交付路线](68-pwa-ui-quality-roadmap.md) 为唯一真源**
**范围：`site/` 前端，优先 PWA**
**基线：Next.js 16、React 19、TypeScript、Tailwind CSS 4**

## 1. 背景

当前 `site/` 使用 Next.js App Router、React、Tailwind CSS 4 和集中式 `globals.css`，没有正式的 UI 组件库。PWA 内部已经自行实现了按钮、输入框、状态标签、Dialog、Sheet、Menu、Settings 面板和 Session 管理等基础交互。

当前架构的主要维护问题：

- `Dialog`、菜单、遮罩、焦点返回、Escape 关闭和滚动处理存在多套实现；
- `SessionSheet` 使用原生 `<dialog>.showModal()`，曾导致 Top Layer 层级与重命名弹窗冲突；
- PWA 基础控件通过大量 `.pwa-*` CSS 分散实现，按钮、输入框和状态标签存在重复样式；
- `site/src/app/globals.css` 承载根布局和 PWA 样式，遗留官网样式清理由 Phase 5 单独处理；
- `site/src/components/pwa/pwa-app.tsx` 同时编排 Relay、IndexedDB、Timeline、配对、Session 和大量 UI 状态，后续迁移成本会持续增加；

这些问题表明，长期项目不应继续手写所有基础交互组件。

## 当前检查点

- Phase 0–4 的完成状态当前有效；历史验收段中的测试数字均为对应提交时的快照，不代表当前值。
- Phase 3 已按 Plan 69 的 `device_id → endpoint_id → runtime_instance_id → session_id/history_generation` 模型重新收口：`pwa-app.tsx` 从约 748 行降至 611 行，并建立 endpoint registry、Timeline viewport、真实扫码 pairing、active device/endpoint selection 和 device-level pairing presence 五个稳定边界。
- `PwaApp` 继续持有 Owner Relay、Session/Timeline 协议编排、device CRUD、pairing IndexedDB transaction 与 UI；没有恢复 Plan 69 删除的 `PairingRecordCard`、`SessionList`、`PwaAppView`、startup 或 probes。
- Phase 5 尚未开始；`site/src/app/globals.css` 约 2321 行，且 PWA 之前仍保留大量已删除站点 selector，须按消费者证据清理。
- 当前全量验证快照只在 Plan 68 维护；Phase 3 冻结时 Node、Browser、coverage、Playwright、TypeScript、Lint、production build、`git diff --check` 与独立聚合审查均已收口。

## 2. 目标

1. 在 PWA 范围建立正式、可持续升级的 React UI 组件基础；
2. 将 Dialog、Drawer、Menu、Input、Button、Badge 等通用能力交给成熟组件库维护；
3. 统一焦点管理、键盘交互、Portal、遮罩、滚动锁定和移动端 overlay 行为；
4. 保留 Remote Pi 现有黑色、天蓝色、终端化视觉，不引入另一套产品品牌；
5. 保持 PWA 路由、启动和视觉稳定，不为迁移基础组件改动业务流程；
6. 让 PWA 业务组件只负责 Pairing、Session、Timeline、Relay 等领域逻辑，减少基础 UI 细节；
7. 支持后续把 `PwaApp` 拆分为连接、配对、Session、Timeline 和 Composer 等独立 hooks/controller。

## 3. 非目标

本计划不包含：

- Plan 66 原批次不修改 Relay、`pi-extension`、协议字段、`room_id`、Pairing 数据语义或 IndexedDB 数据模型；Plan 69 已在其独立范围内取代该跨端边界；
- 不重建已删除的 Landing、Docs、Tutorials 或 Legal 页面；
- 不一次性重写所有 PWA 业务组件；
- 不引入大型全局状态管理库；
- 不引入新的 CSS-in-JS 体系来替换 Tailwind 4；
- 不在组件库迁移中顺便改动产品文案、品牌图标或业务流程；
- 不为了统一而机械迁移已有稳定且无问题的 Markdown、QR 扫描和消息渲染逻辑。

## 4. 组件库决策

### 4.1 采用 Mantine

PWA 采用 **Mantine** 作为完整 React UI 组件库，优先使用：

- `@mantine/core`
- `@mantine/hooks`

只有在确实需要通知中心时，再单独评估 `@mantine/notifications`；不预先安装完整 Mantine 生态。

Mantine 负责通用组件的实现、可访问性和交互行为，Remote Pi 负责主题、业务组件和领域状态。

### 4.2 不采用的方案

- **MUI**：成熟度高，但 Material 视觉、样式体系和 App Router 样式注入成本与当前 Tailwind-first、终端化 PWA 不匹配；
- **Ant Design**：更适合企业后台、表格和复杂业务表单，与当前聊天和实时 Session PWA 的产品形态差异较大；
- **shadcn/ui + Radix**：定制能力强，但组件源码进入项目后仍需项目自行维护，不符合“减少基础组件自维护”的核心目标；
- **Radix UI 直接使用**：主要提供行为原语，仍需自行建立和维护完整视觉组件层；
- **Headless UI**：与 Tailwind 友好，但当前 PWA 需要的完整控件覆盖和复杂 overlay 能力不如 Mantine 适合作为长期基座；
- **Base UI**：保留为未来专项 spike 的候选，不作为当前默认基座。

### 4.3 采用边界

组件库只替代基础 UI 能力，不替代 Remote Pi 业务组件：

```text
Mantine：Button / Input / Dialog / Drawer / Menu / Badge / Tooltip
Remote Pi：PairingRecord / Session / Timeline / MessageComposer / Relay 状态
```

## 5. 目标架构

```text
site/src/
├── app/
│   └── app/
│       ├── layout.tsx              # PWA 局部 Provider 边界
│       └── page.tsx
├── components/
│   ├── ui/                         # 项目统一的基础 UI 入口
│   │   ├── button.tsx
│   │   ├── icon-button.tsx
│   │   ├── input.tsx
│   │   ├── textarea.tsx
│   │   ├── badge.tsx
│   │   ├── dialog.tsx
│   │   ├── drawer.tsx
│   │   ├── menu.tsx
│   │   └── tooltip.tsx
│   └── pwa/                        # Remote Pi 业务组件
│       ├── session-drawer.tsx
│       ├── rename-pairing-dialog.tsx
│       ├── pairing-record-card.tsx
│       └── ...
└── lib/
    └── ui/
        ├── theme.ts                # Remote Pi Mantine theme
        └── utils.ts                # 仅保留必要的 class/样式辅助
```

### 5.1 Provider 边界

`MantineProvider` 只放在 PWA 路由子树，不放到根 `src/app/layout.tsx`：

```text
RootLayout
  └── /app：PwaUiProvider → PwaApp
```

这样可以保持根布局为 Server Component，并将 Mantine Provider、交互运行时和
PWA 主题限制在 `/app` 子树。

具体 Provider 放置方式以 Next.js 16 对嵌套路由布局和全局 CSS 的构建约束为准；如 Mantine CSS 必须在根布局导入，则只导入静态样式，Provider 仍保持 PWA 局部化，并通过作用域和回归测试防止官网样式变化。

### 5.2 本地 UI wrapper

业务组件不得在各处直接散落 Mantine 具体 API。项目在 `components/ui/` 提供薄 wrapper：

- 统一 `size`、触摸目标、语义颜色和默认 variant；
- 统一 Remote Pi 的 `--pwa-*` token 映射；
- 屏蔽未来更换底层组件库的 API 差异；
- wrapper 不重新实现 Dialog、Drawer、Menu 等行为，不复制一套手写焦点逻辑。

wrapper 必须保持轻量。简单的 `Button` 或 `Badge` 可以直接导出 Mantine 组件的受控变体；只有存在真实产品约束时才新增业务 prop。

## 6. 组件迁移映射

| 当前实现 | 目标组件 | 迁移优先级 | 说明 |
|---|---|---:|---|
| `pwa-primary-button` / `pwa-secondary-button` | `Button` | P0 | 保留主次色和 44px 触摸目标 |
| `pwa-icon-button` | `ActionIcon` | P0 | 统一 aria-label、尺寸和 hover/focus |
| 重命名输入框 | `TextInput` | P0 | 保留自动聚焦、Enter 保存和错误提示 |
| `SessionSheet` | `Drawer` | P0 | 移动端从左侧打开，替代原生 `<dialog>` |
| `RenamePairingDialog` | `Modal` | P0 | 使用统一 Portal、Focus Trap 和 Escape 行为 |
| `SettingsPanel` | `Drawer` 或 `Modal` | P1 | 根据桌面/移动端布局分别设定方向和尺寸 |
| `MobileTopbarMenu` | `Menu` | P1 | 统一 outside click、Escape 和键盘导航 |
| composer 图片菜单 | `Menu` / `Popover` | P1 | 不改变图片选择和业务状态 |
| `ComposerCommandMenu` 外层 | `Popover` | P1 | 内部模型和 thinking 业务逻辑继续保留 |
| `pwa-presence-label` / `pwa-current-label` | `Badge` | P1 | 保留 ONLINE、OFFLINE、CHECKING、CURRENT 语义 |
| 原生 `select` | `Select` | P1 | 先验证移动端键盘和长选项行为 |
| 长列表滚动容器 | `ScrollArea` | P2 | 只在原生滚动行为不足时采用，避免无收益替换 |
| Tooltip | `Tooltip` | P2 | 仅替换确有 hover/focus 说明需求的 title |

以下仍由项目自行维护：

- `PairingRecordCard`；
- `Session` 列表和在线状态聚合；
- `MessageList`、Markdown renderer 和流式输出；
- `MessageComposer` 的 Relay 发送、图片附件和队列状态；
- QR 扫描与摄像头生命周期；
- Relay、Timeline、Dexie 和连接重试逻辑。

## 7. 分阶段迁移计划

### Phase 0 — 基线与 spike

**状态：已完成（2026-08-28）**

1. 锁定当前 site 构建、类型检查、Lint、组件测试和 `/app` 浏览器 smoke 基线；
2. 安装时核对 Mantine 当前版本与 React 19、Next 16、Tailwind 4 的 peer 兼容性；
3. 只安装 `@mantine/core` 和 `@mantine/hooks`，同步 `site/pnpm-lock.yaml`；
4. 创建最小 `PwaUiProvider` 和 Remote Pi theme；
5. 在独立试点同时验证 `Drawer`、`Modal`、`Menu`、`Button`、`TextInput`；
6. 验证 PWA standalone、iOS/Android viewport、safe-area、键盘弹起、背景滚动锁定、Portal 层级和焦点返回；
7. 若 Mantine 与当前构建或样式边界存在不可接受冲突，停止扩大迁移，记录 finding 后重新评估 Base UI 或 Radix。

**验收：**已通过 Mantine 9.5.2 与 React 19 / Next 16 的兼容核对；PWA 局部 Provider 与主题构建成功；`Drawer`、`Modal`、`Menu`、`Button`、`TextInput` 试点可静态渲染；Landing/Docs `/app` smoke 正常。实际 iOS/Android 真机交互仍在 Phase 1 验收中持续覆盖。

### Phase 1 — Overlay 基础设施

**状态：已完成（2026-08-28）**

按当前问题优先迁移：

1. `SessionSheet` → `Drawer`；
2. `RenamePairingDialog` → `Modal`；
3. `SettingsPanel` → `Drawer` / `Modal`；
4. `MobileTopbarMenu` → `Menu`。

移动端 Session 管理正式采用左侧抽屉：

- 左侧滑入；
- 右侧显示遮罩；
- 点击遮罩、关闭按钮或 Escape 关闭；
- 适配 `safe-area-inset`；
- Drawer 内部可独立滚动；
- 重命名打开时不再同时保留 Session overlay；
- 不依赖原生 `<dialog>.showModal()`。

**验收：**已将 Session 管理迁移为左侧 Mantine Drawer，重命名迁移为 Mantine Modal，Settings 迁移为 Mantine Drawer，移动菜单迁移为 Mantine Menu；移除相关手写焦点/Escape/outside-click 逻辑；保留 Pairing、Session、CURRENT、离线不可切换和本地重命名语义；补齐 PWA 主题作用域、Portal 边界、重置布局稳定性和移动端 safe-area。真实移动设备手势、键盘和焦点体验需在测试环境继续验收。

### Phase 2 — 基础控件

**状态：已完成（2026-08-29）**

迁移 Button、ActionIcon、TextInput、Textarea、Select、Badge、Tooltip，并逐步删除对应的重复样式。

要求：

- 组件库控件的视觉通过 Remote Pi theme 和 wrapper 映射到现有 token；
- 不直接复制 Mantine 默认主题；
- 不把 `room_id`、Relay 状态或 IndexedDB 操作塞进基础组件；
- 组件仍满足至少 44px 的移动端交互目标；
- 所有 icon-only 操作有可访问名称；
- 状态文本不能只依赖颜色。

**验收：**已在 `site/src/components/ui/` 建立 Button、IconButton、Input、Textarea、Select、Badge 和 Tooltip 薄 wrapper，PWA 生产消费者不再直接导入对应 Mantine 基础控件；共享 tone、状态、44px 触摸目标和输入尺寸已收敛，重复基础 Button/Input/Badge 行为样式已删除。以下测试数字是实现提交 `b06f15d` 对应的历史快照，非当前值：legacy 128/128、Browser Mode 64/64、coverage 64/64、TypeScript、受影响 ESLint、production build、桌面与 `390×844` 测试环境 smoke 和独立审查均通过；全量 Lint 仍仅受既有生成文件 `site/public/sw.js` 的 `@typescript-eslint/no-this-alias` 阻断。

### Phase 3 — 业务组件收敛

**技术状态：已完成（2026-09-01）；已按 `device`/`endpoint` 新模型重新收口**

Plan 69 前的 `PairingRecordCard`、`SessionList` / `SessionRow`、`PwaAppView`、PWA startup 与非当前配对 probes 仅是历史实现快照；当前实现没有恢复这些边界。Phase 3 在 `PwaApp` 保留跨域协议编排的前提下，按真实 owner 完成五个独立批次：

1. `useEndpointRegistry`：拥有 endpoint 缓存恢复、snapshot/announce/update/ended、runtime takeover、在线状态与 endpoint 持久化失效；
2. `useTimelineViewport`：拥有输出跟随、未读 group 去重、滚动 refs、RAF 自动跟随、Latest 与 reset，不拥有 Timeline 数据和 Session；
3. `useDevicePairing`：拥有一次真实扫码配对的临时 Relay/PeerChannel、15 秒 timeout、错误、取消、重复 attempt 与卸载清理；pairing transaction 仍由 `PwaApp` 持有；
4. `useActiveEndpointSelection`：拥有 active device/endpoint 恢复、持久化、切换与 stale restore 抑制，不拥有 endpoint presence 或 Session；
5. `derivePairingPresence`：纯派生 device-level `checking/offline/online/partial` view model，无 effect、数据库或 transport 所有权。

`PwaApp` 从约 748 行降至 611 行；Owner Relay、Session/Timeline 协议编排、device CRUD、pairing IndexedDB transaction、Composer 与 UI 仍保留在其明确边界内。Relay lifecycle 和完整 Session/Timeline controller 因共享恢复状态、请求 refs、assembler 与 channel generation 未被机械抽取。

**验收：**五个结构批次均有独立自动化验证和只读审查；最终聚合审查发现的重复 pairing attempt 生命周期问题已由独立修复关闭。当前模型下业务组件只接收稳定 props/view model，没有修改协议、IndexedDB schema、CSS 或 Plan 69 已删除边界；完整阶段验证与准确数字以 Plan 68 当前检查点为准。下文旧验收数字和提交（`c5e3cce`、`7e8f35d`、`6785b64`、`f579ee7`）仅记录 Plan 69 前历史批次。

### Phase 4 — 遗留站点移除与低收益组件评估

**状态：已完成**

1. 删除遗留官网、文档、教程、法律页面、上游 OG image 及其仅有消费者；根路径改为服务端重定向至 `/app`，保留 Docker 根路径 healthcheck；
2. `Tabs` 的消费者随遗留页面删除，原 Tabs 迁移决策点不再适用；
3. `ScrollArea`、Tooltip、Popover 按实际消费者和收益保持现状，不为组件库覆盖率进行替换；
4. 不在本阶段清理 `globals.css` 中的大段遗留样式，交由 Phase 5 单独收敛。

**验收：**Site 仅保留 `/app` 产品页面与根路径重定向；没有为已删除页面保留无消费者组件或无收益组件库迁移。

### Phase 5 — 清理与长期维护

**技术状态：尚未实施；执行顺序以 Plan 68 为准**

`globals.css` 当前约 2321 行，PWA 前仍保留大量已删除站点 selector。本阶段在不改变 PWA 业务布局、消息流、终端视觉和 safe-area 特殊样式的前提下，按实际消费者删除无效的遗留站点与已被组件库替代的重复基础样式。

1. 先基于实际消费者盘点 selector，再删除无消费者的遗留站点样式；
2. 保留 PWA 业务布局、消息流、终端视觉和 safe-area 特殊样式；
3. 将全局 token、PWA token 和 Mantine theme 的关系记录在同一处；
4. 记录 Mantine 版本、升级窗口和兼容验证命令；
5. 每次 Mantine 升级先在 PWA smoke 和构建中验证，再扩大到全部受影响消费者。

**验收：**没有遗留两套同名基础行为；未迁移的自定义 CSS 都能明确对应业务布局或品牌视觉；已删除站点 selector 不再无证据保留。

## 8. 主题与样式约束

### 8.1 Token 真源

现有 Remote Pi token 继续作为视觉真源：

- 黑色背景和深色 surface；
- 天蓝色 accent；
- 白色主文字与灰阶辅助文字；
- 当前字体族；
- PWA 的 safe-area、边框、危险状态和在线状态语义。

Mantine theme 只做映射，不另起一套无法解释的颜色命名。现有 `--green` 等历史兼容命名不在本计划中静默重命名，待独立 token 整理任务处理。

### 8.2 CSS 边界

- `globals.css` 继续保留全局 reset、字体、站点 token 和尚未迁移的页面样式；
- Mantine 样式只加载一次；
- 不引入第二套全局 reset、字体或 body 背景；
- PWA 特殊布局、消息 Markdown、QR 扫描和 safe-area 仍可使用 `.pwa-*` CSS；
- Phase 5 清理前，遗留官网 selector 继续保留在 `globals.css`，但不得影响 PWA 组件；
- 迁移一个组件后再删除其旧样式，禁止先删后补。

## 9. 运行时与构建约束

1. 保持 Server Component 默认策略；Mantine hooks、Portal 和交互组件只在 PWA client subtree 使用；
2. 保持 `site/src/app/app/` 的 `/app` PWA scope，不改变 Serwist 缓存边界；
3. 维持 Next.js standalone Docker 输出；
4. 核对 Webpack、standalone、Service Worker 和生产缓存中 Mantine CSS/字体资源的表现；
5. 按路由和组件按需加载，不引入已删除站点页面的交互代码；
6. 不改变 Relay WebSocket、IndexedDB、Pairing、Session 和 Timeline 的数据流；
7. 组件库升级必须锁定 `pnpm-lock.yaml`，不接受隐式漂移。

## 10. 验证矩阵

每个阶段至少运行受影响验证：

```bash
cd site && pnpm exec tsc --noEmit --pretty false
cd site && pnpm exec eslint <受影响文件>
cd site && pnpm exec node --test --import tsx <受影响测试>
cd site && pnpm build
cd .. && git diff --check
```

浏览器与响应式验收：

- `/app` 桌面 viewport；
- iOS Safari / standalone viewport；
- Android Chrome / standalone viewport；
- Session Drawer 左侧滑入、遮罩、滚动和关闭；
- Rename Modal 自动聚焦、输入法、Enter、Escape、保存失败；
- Settings、Menu、Select 的键盘与触摸行为；
- 背景滚动锁定和关闭后焦点恢复；
- `prefers-reduced-motion`；
- `/` 重定向至 `/app`，并验证 PWA 启动页面无回归；
- 浏览器控制台无新增错误。

完整 `pnpm lint` 如果继续命中已有 `site/public/sw.js` 的历史错误，必须区分既有失败与本计划引入的问题，并单独运行受影响文件 ESLint。

## 11. 回滚策略

- 每个 Phase 独立提交，禁止把完整迁移压成一个不可回滚的大提交；
- Provider、theme、依赖和业务迁移保持可单独回退；
- 第一阶段试点失败时，只回退 Mantine 依赖、Provider 和试点组件，不触碰协议与本地数据；
- 迁移期间保留旧组件测试，直到新组件通过桌面、移动端和生产构建验证；
- 不通过删除旧 CSS 或改变业务状态来掩盖视觉问题。

## 12. 调度引用

当前执行状态、跨计划顺序和切换门禁只在 Plan 68 维护。本文只记录 Plan 66 的技术范围、当前实现事实和验收标准；不得以旧 Phase 3 的历史完成记录跳过当前 `device`/`endpoint` 模型收口。

## 13. 后续决策点

以下事项在对应 Phase 开始前单独确认，不在本计划中提前扩大范围：

1. Mantine 的具体版本及 React 19 / Next 16 peer 兼容结果；
2. Provider 的最终导入位置及 Mantine CSS 与 Next.js App Router 的边界；
3. PWA theme 中字体、radius、control height 和状态色的精确映射；
4. Settings 在桌面端使用侧栏、移动端使用 Drawer 的具体形态；
5. 是否引入 `@mantine/notifications`。

## 14. 完成定义

本计划完成需满足：

- PWA 基础 Dialog、Drawer、Menu、Button、Input、Badge 等能力由 Mantine 提供；
- Session 管理在移动端使用稳定的左侧 Drawer；
- 重命名、Settings、Menu 的层级、焦点、Escape 和滚动行为统一；
- 当前 `device`/`endpoint` 模型下的 Pairing、Session、Timeline、Relay 与本地数据语义保持正确，且 `pwa-app.tsx` 的业务组件边界已按该模型重新收口；
- `/` 的服务端重定向和 `/app` PWA 启动行为正确；
- `globals.css` 中无消费者的已删除站点 selector 与被组件库替代的重复基础样式已按证据清理；
- 相关 TypeScript、Lint、测试、构建和浏览器验收通过；
- 迁移后的旧 `.pwa-*` 样式只保留业务布局、消息渲染和品牌特有视觉；
- 版本、升级和回滚方式已由项目文档记录。
