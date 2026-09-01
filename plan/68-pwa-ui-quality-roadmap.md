# Plan 68 — PWA UI 与自动化测试交付路线

> 状态：进行中
>
> 创建日期：2026-08-29
>
> 更新日期：2026-09-01
>
> 适用范围：`site/` 中的 PWA UI、组件库迁移和自动化测试建设。

## 1. 文档职责

本文档是以下两份计划的**跨计划调度真源**：

- [Plan 66 — Site UI 组件库引入与 PWA 迁移](66-ui-component-library-migration.md)：维护 Mantine 迁移范围、UI 架构、组件边界和 UI 验收标准；
- [Plan 67 — PWA 自动化测试体系](67-pwa-automated-testing.md)：维护测试分层、测试命名、覆盖边界和测试实现标准。

本文档只维护：

- 当前正在执行的计划和 Phase；
- 计划之间的顺序、依赖和切换条件；
- 每个检查点的验证门禁与提交边界；
- 影响调度的风险、非目标和后续决策。

不在本文档复制两份计划的详细技术方案。若本文件与具体计划的技术约束冲突，以具体计划为准；若涉及已关闭的产品或架构决策，以 [Plan 00](00-decisions.md) 为准。

## 2. 当前检查点

更新时间：2026-09-01

| 计划 | 阶段 | 状态 | 事实与出口条件 |
|---|---|---|---|
| Plan 67 | Phase 1：基础设施与确认 Modal 试点 | 已完成 | Vitest Node/Browser Mode、Chromium provider、Browser render harness 和确认操作测试已建立。 |
| Plan 67 | Phase 2：高风险交互组件 | 已完成 | Rename、Settings、Session Drawer、Composer、Mobile Menu、QR Scanner 和 Service Worker Notice UI 的 Browser 覆盖已完成。 |
| Plan 67 | Phase 3：统一 Node 测试 API | 已完成 | 31 个 legacy 文件与仍使用 `node:test` 的 `protocol.node.test.ts` 已迁入 Vitest Node；legacy 与源码 `node:test` 导入均为 0。默认 `pnpm test` 串行运行 Node 与 Browser。 |
| Plan 67 | Phase 4：`/app` E2E 基线 | 已完成 | 隔离 Playwright `/app` 基线、IndexedDB fixture、Settings、Session Drawer、Composer、清库确认、desktop/mobile viewport 与 Service Worker 注册覆盖已建立。 |
| Plan 66 | Phase 0–2 | 已完成 | Mantine 基础设施、Overlay 和基础控件迁移当前有效完成。 |
| Plan 66 | Phase 3：业务组件收敛 | 已完成 | 已按 Plan 69 新模型抽取 endpoint registry、Timeline viewport、真实扫码 pairing、active device/endpoint selection 与 pairing presence；`pwa-app.tsx` 约 748→611 行，未恢复旧组件、startup 或 probes。 |
| Plan 66 | Phase 4：遗留站点移除与低收益组件评估 | 已完成 | 已移除遗留官网、文档、教程、法律页面、上游 OG image 及仅有消费者；`/` 服务端重定向到唯一产品路由 `/app`。 |
| Plan 66 | Phase 5：清理与长期维护 | 已完成 | `globals.css` 已从约 2321 行按消费者证据清理至 546 行；PWA 业务布局、消息流、终端视觉、Mantine overlay/focus/Portal、safe-area 和响应式边界已核对。 |
| Plan 69 | PWA Owner Relay/session 恢复与 v7 E2E fixture | 自动化已完成；完整真实矩阵未完成 | 已有真实配对/Relay 重连和历史恢复局部证据：offline/online 3 轮、直接关闭 WebSocket 2 轮，清本地 timeline 后均从远端恢复 2 条并回到 Connected。daemon、两个 interactive Pi、双 PWA profile、supervisor/child crash、runtime takeover 与 `/new` 的完整矩阵仍待验收。 |

当前实跑验证：Vitest Node 34 files、125/125；Browser 15 files、100/100；coverage 49 files、225/225，Statements 70.15%、Branches 62.44%、Functions 71.34%、Lines 77.96%；Playwright desktop/mobile 10/10；TypeScript、production build 与 `git diff --check` 均通过。全量 `pnpm lint` 在清理 `.gitignore` 已登记的 coverage 与 Serwist 生成物后通过，0 errors，仅保留 3 个既有 `<img>` warning；未修改生成物或 ESLint 配置规避错误。旧段落中的测试数字仅为对应提交时历史快照，不代表当前值。

当前已形成的 Plan 67 Phase 2 本地提交：

- `0868ec54`：修复 Composer Overlay 焦点竞态；
- `87049c17`：收敛设置抽屉与移动菜单交互；
- `653f6ff9`：修复 QR Scanner 生命周期竞态；
- `601a8003`：补充 Service Worker 通知浏览器测试。

Plan 66 Phase 2 本地提交：

- `b06f15d`：标准化 PWA 基础控件，收敛共享样式并补齐真实浏览器尺寸与 Select 覆盖。

Plan 66 Phase 3 当前模型本地提交：

- `ac2a186`：抽取 endpoint registry；
- `d5a8ebf`：抽取 Timeline viewport；
- `96f2bbf`：抽取真实扫码 device pairing；
- `4cf0c52`：抽取 active device/endpoint selection；
- `c09edd6`：抽取 device-level pairing presence view model；
- `d649f38`：关闭聚合审查发现的重复 pairing attempt 生命周期问题。

Plan 69 前历史 Phase 3 提交 `c5e3cce`、`7e8f35d`、`6785b64`、`f579ee7` 已被新模型取代，仅保留为历史记录。

Plan 67 Phase 3 首批 Node 迁移本地提交：

- `88f875a`：将 encoding、crypto、pairing 和 protocol 的 9 项纯逻辑测试迁移到 Vitest Node。

Plan 67 Phase 4 `/app` E2E 基线本地提交：

- `79922cc`：建立独立 Playwright Test 配置、standalone server、IndexedDB fixture 及 desktop/mobile 关键流程覆盖。

三份计划的当前状态与后续顺序以本轮同步内容为准；旧提交、测试数量和验收记录仅保留为历史快照。

## 3. 后续执行顺序

### 阶段 A：Plan 67 Phase 3 — 统一 Node 测试 API

**状态：已完成**

31 个 legacy 文件与仍导入 `node:test` 的 `protocol.node.test.ts` 已分批迁移为真正的 Vitest Node 测试；迁移前后的 Node/SSR 总量均为 122。legacy runner 和 Site 对 `tsx` 的直接依赖已移除，默认 `pnpm test` 现已串行覆盖 Vitest Node 与 Browser。

切换门禁：

- 31 个 legacy 文件与 2 个 `*.node.test.ts` 文件的 runner、数量和直接 scripts 消费者均已核对；
- 现有 legacy Node/SSR 测试全部迁入 Vitest Node，源码不再导入 `node:test`，且迁移前后测试语义与数量可核对；
- legacy runner 已移除，默认 `pnpm test` 明确串行运行 Vitest Node 与 Browser；
- Node、Browser、coverage、Playwright、TypeScript、受影响 ESLint、production build 和 `git diff --check` 通过；
- 全量 lint 的生成文件 error 与既有 warnings 仍被明确区分。

### 阶段 B：Plan 66 Phase 3 — 按 `device`/`endpoint` 模型重新收口

**状态：已完成（2026-09-01）**

已按 Plan 69 的 `device_id → endpoint_id → runtime_instance_id → session_id/history_generation` 模型完成五个稳定边界：endpoint registry、Timeline viewport、真实扫码 pairing、active device/endpoint selection 和 device-level pairing presence。`PwaApp` 从约 748 行降至 611 行，并继续持有 Owner Relay、Session/Timeline 协议编排、device CRUD、pairing transaction 与 UI；没有恢复已删除的旧结构。

切换门禁：

- `device`/`endpoint`、连接、Session 与 Timeline 的直接消费者和所有权已盘点；
- 业务组件只接收稳定 props/view model；
- `PwaApp` 的 UI 编排与领域逻辑边界有可核对改善；
- 每个结构调整批次独立验证。

### 阶段 C：Plan 66 Phase 5 — CSS 清理与长期维护

**状态：已完成（2026-09-01）**

本阶段已在 `globals.css` 从约 2321 行的基线上按实际消费者完成清理，最终文件为 546 行。四个独立本地提交依次为 `09acf5d`、`ab2d03c`、`eb49ddc`、`63cf272`；当前 149 个 PWA CSS class 名均能在 `site/src` 或 `site/e2e` 找到对应消费者。未重新纳入已删除官网页面或 Tabs，PWA 业务布局、消息流、终端视觉、Mantine overlay/focus/Portal、safe-area 和响应式边界均保留。

阶段出口已通过：

- 每个删除的 selector 和 token 均完成源码、测试、动态 class 与 Mantine 消费者核对；
- Browser Mode 15 个文件/100 个用例、TypeScript、受影响目录 ESLint、production build、Playwright desktop/mobile 10/10 和 `git diff --check` 通过；
- 独立只读审查无 P0–P3 finding。

下一阶段按本文件顺序切换至阶段 D 的 Plan 69 完整真实矩阵。

### 阶段 D：Plan 69 — 完整真实矩阵

**状态：最后执行**

Plan 69 自动化已完成，且已有 offline/online 三轮和直接关闭 WebSocket 两轮的局部真实恢复证据：清本地 timeline 后均从远端恢复 2 条并回到 Connected。最后才执行 daemon、两个 interactive Pi、双 PWA profile、supervisor/child crash、runtime takeover 与 `/new` 的完整真实矩阵；该矩阵未完成前，不得宣称跨端恢复验收完成。

## 4. 调度规则

1. 同一时间只推进一个需要修改生产代码或测试代码的主阶段；验证和独立审查可以作为该阶段的收口活动。
2. 阶段未形成清晰检查点前，不把下一阶段的实现混入当前工作区。
3. 每个实现批次按职责拆分为可回退的本地提交；提交、push、部署和 Pull Request 仍需分别授权。
4. 发现边界清晰、证据充分且直接阻塞当前门禁的相邻回归，可以实施最小修复，并在提交说明和验证记录中标明；独立功能不自动扩大范围。
5. 新测试只放在其最可靠的层：纯逻辑进入 Node，真实 DOM/焦点/布局进入 Browser Mode，跨模块流程进入 Playwright E2E，真实设备能力继续由设备验收覆盖。
6. Browser runner 与 coverage 串行运行，避免共享 Vite 优化缓存、端口和 Chromium 资源造成时序假失败。
7. Plan 66、Plan 67 的详细技术正文不在本文档重复维护；阶段状态、顺序和出口条件只在本文档维护。

## 5. 统一验证门禁

### 局部批次

```bash
cd site && pnpm exec vitest run --project <受影响项目> <受影响测试>
cd site && pnpm exec tsc --noEmit --pretty false
cd site && pnpm exec eslint <受影响文件>
cd .. && git diff --check
```

### 阶段冻结

```bash
cd site && pnpm test
cd site && pnpm test:unit
cd site && pnpm test:coverage
cd site && pnpm exec tsc --noEmit --pretty false
cd site && pnpm lint
cd site && pnpm build
cd .. && git diff --check
```

当前 `pnpm test` 已串行运行 Vitest Node 与 Browser；`pnpm test:unit` 继续保留为 Node 层专项入口。

阶段冻结若先运行 coverage/build，应在 lint 前清理 `.gitignore` 已登记的 `coverage/` 与 Serwist Service Worker 生成物，避免 ESLint 扫描非源码；不得修改生成物或放宽规则来规避错误。受影响源码仍须单独通过目标 ESLint。

### 阶段审查

- 审查对象为冻结 diff，不审查仍可能继续写入的工作区；
- 实现代理不得替代独立只读审查；
- 所有子代理进入终态后才能交付；
- 审查发现由主 Agent 判断是否修复，修复后只重跑受影响验证并重新冻结 diff。

## 6. 非目标与风险

本调度不改变以下边界：

- Plan 66/67 原批次不修改 Relay、Pi Extension、Protocol v2、IndexedDB 数据模型或生产部署契约；Plan 69 已在其独立范围内取代该限制；
- 不把 Browser Mode 作为 Playwright `/app` E2E 或真实设备验收的替代品；
- 不为 Settings 保存失败擅自定义新的 UI、回滚或错误展示语义；
- 不为真实 QR 摄像头、Service Worker lifecycle、Standalone 和软键盘能力制造虚假的组件测试结论；
- 不因 Plan 66 后续结构拆分而阻塞当前 Plan 67 已完成的 Browser 测试建设；
- 不因测试迁移而一次性重写全部 legacy 测试。

剩余已知风险和真实设备边界，以 Plan 66、Plan 67 及项目技能中的专项记录为准。

## 7. 后续更新规则

阶段完成时按以下顺序更新：

1. 先把仍有效的技术事实同步到 Plan 66 或 Plan 67 的对应章节；
2. 再在本文档更新阶段状态、当前实跑结果与历史快照的区分；
3. 按“Plan 67 Phase 3 → Plan 66 Phase 3 新模型收口 → Plan 66 Phase 5 → Plan 69 完整真实矩阵”切换下一阶段，并明确其前置条件；
4. 不在三份文档中重复维护同一份详细测试或实现清单。
