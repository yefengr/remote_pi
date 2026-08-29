# Plan 68 — PWA UI 与自动化测试交付路线

> 状态：进行中
>
> 创建日期：2026-08-29
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

更新时间：2026-08-29

| 计划 | 阶段 | 状态 | 事实与出口条件 |
|---|---|---|---|
| Plan 67 | Phase 1：基础设施与确认 Modal 试点 | 已完成 | Vitest Node/Browser Mode、Chromium provider、Browser render harness 和确认操作测试已建立并通过验证。 |
| Plan 67 | Phase 2：高风险交互组件 | 已完成 | Rename、Settings、Session Drawer、Composer、Mobile Menu、QR Scanner 和 Service Worker Notice UI 覆盖已完成；Browser 56/56，legacy 128/128，coverage 56/56，TypeScript、受影响 ESLint、production build 和 diff check 已通过。 |
| Plan 66 | Phase 0–1 | 已完成 | Mantine 基础设施和 Overlay 迁移已完成。 |
| Plan 66 | Phase 2：基础控件 | 已完成 | 项目 UI wrapper、生产消费者迁移、共享样式收敛和 44px/Select Browser 覆盖已完成；legacy 128/128、Browser/coverage 64/64、TypeScript、受影响 ESLint、production build、测试环境 QA 和独立审查通过。实现提交：`b06f15d`。 |
| Plan 67 | Phase 3：统一 Node 测试 API | 已完成首批 | 4 个纯 TypeScript 测试文件、9 项测试已迁移到 Vitest Node；legacy 119/119、Node 9/9、Browser 64/64、coverage 73/73、TypeScript、受影响 ESLint、production build 和独立审查通过。实现提交：`88f875a`。 |
| Plan 67 | Phase 4：`/app` E2E 基线 | 已完成 | 独立 Playwright Test 基线覆盖 production standalone 启动、IndexedDB 隔离 fixture、Settings、Session Drawer、Composer、清库确认、desktop/mobile viewport 和真实 Service Worker 注册。E2E 8/8，重复运行 16/16；TypeScript、受影响 ESLint、现有 Node/legacy/Browser/coverage、production build、diff check 和独立审查通过。实现提交：`79922cc`。 |

当前已形成的 Plan 67 Phase 2 本地提交：

- `0868ec54`：修复 Composer Overlay 焦点竞态；
- `87049c17`：收敛设置抽屉与移动菜单交互；
- `653f6ff9`：修复 QR Scanner 生命周期竞态；
- `601a8003`：补充 Service Worker 通知浏览器测试。

Plan 66 Phase 2 本地提交：

- `b06f15d`：标准化 PWA 基础控件，收敛共享样式并补齐真实浏览器尺寸与 Select 覆盖。

Plan 67 Phase 3 首批 Node 迁移本地提交：

- `88f875a`：将 encoding、crypto、pairing 和 protocol 的 9 项纯逻辑测试迁移到 Vitest Node。

Plan 67 Phase 4 `/app` E2E 基线本地提交：

- `79922cc`：建立独立 Playwright Test 配置、standalone server、IndexedDB fixture 及 desktop/mobile 关键流程覆盖。

`plan/67-pwa-automated-testing.md` 保持原样和未跟踪状态，不作为本次调度文档变更的一部分。

## 3. 执行顺序

### 阶段 A：Plan 66 Phase 2 收口

**状态：已完成（2026-08-29）**

工作范围：

- 全面盘点基础控件迁移消费者；
- 核对组件库已覆盖行为与残留 `.pwa-*` 基础样式；
- 验证 44px 触摸目标、ARIA、状态文本、移动布局和业务行为不变；
- 只修复直接阻塞 Phase 2 验收的缺口；
- 完成独立验证后，将 Plan 66 Phase 2 标记为已完成。

切换门禁：

- 盘点结果明确，没有遗漏的 P0/P1 基础控件；
- 受影响 TypeScript、ESLint、测试、production build 和 `git diff --check` 通过；
- 迁移范围形成独立、可回退的本地提交；
- 未改变 Relay、Protocol v2、IndexedDB 数据模型和 PWA 业务语义。

### 阶段 B：Plan 67 Phase 3 首批 Node 迁移

**状态：已完成（2026-08-29）**

首批范围固定为：

```text
site/src/lib/remote-pi/encoding.test.ts  → encoding.node.test.ts
site/src/lib/remote-pi/crypto.test.ts    → crypto.node.test.ts
site/src/lib/remote-pi/pairing.test.ts  → pairing.node.test.ts
site/src/lib/remote-pi/protocol.test.ts → protocol.node.test.ts
```

只转换测试 runner 和断言 API：

- `node:test` → Vitest `test`；
- `node:assert/strict` → Vitest `expect`；
- 保持输入、期望值、异常语义和测试数量不变；
- 不同时迁移大型 fixture、Timeline、数据库或 SSR 组件测试。

切换门禁：

- Node project 9/9 通过；
- legacy 测试从 128 降为 119；
- 总测试量保持 192：119 legacy + 9 Node + 64 Browser；
- coverage、TypeScript、受影响 ESLint、production build 和 `git diff --check` 通过；
- 独立只读审查确认迁移未改变测试语义。

### 阶段 C：Plan 67 Phase 4 `/app` E2E 基线

**状态：已完成（2026-08-29）**

建立最小 Playwright Test 基线，覆盖：

- `/app` 启动和 PWA Provider 集成；
- IndexedDB 隔离 fixture；
- Settings、Session Drawer、Composer 和确认流程的完整应用路径；
- Desktop 与移动 viewport；
- 可自动化的 Service Worker 行为。

真实 Relay/Pi 链路、真实 Service Worker lifecycle、摄像头授权、Standalone 和软键盘仍按 Plan 67 的 E2E/真实设备边界逐步加入，不在基础 E2E 建设中扩大协议或生产部署范围。

切换门禁：

- Chromium E2E 可重复运行且数据隔离；
- 不执行真实用户数据删除或生产清库；
- `/app` 关键路径有稳定失败诊断；
- 真实设备仍保留 Safari/Standalone、摄像头、软键盘和安全区验收。

### 阶段 D：Plan 66 Phase 3 业务组件收敛

**当前优先级：待开始（阶段 C 已完成）**

按 Plan 66 的范围推进 `PairingRecordCard`、`SessionList`/`SessionRow`、PwaApp view model 和 feature hooks 的拆分。先使用已建立的 Browser Mode 与 `/app` E2E 基线锁定行为，再进行结构调整。

切换门禁：

- Pairing、Session、Timeline、Relay 和 IndexedDB 行为回归通过；
- 业务组件只接收整理后的 props/view model；
- `PwaApp` 的 UI 编排与领域逻辑边界有可核对的改善；
- 每个结构调整批次独立提交和验证。

### 阶段 E：Plan 66 Phase 4–5

**前置条件：阶段 D 完成**

按收益逐项评估 Tabs、ScrollArea、Tooltip 和旧样式清理。对没有明确收益的组件保持现状，不以组件库覆盖率为目标进行机械替换。

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
cd site && pnpm test:coverage
cd site && pnpm exec tsc --noEmit --pretty false
cd site && pnpm lint
cd site && pnpm build
cd .. && git diff --check
```

全量 lint 若继续命中生成文件 `site/public/sw.js` 的既有 `@typescript-eslint/no-this-alias` 错误，必须保留该事实，不通过修改生成文件规避，并单独确认受影响文件没有新增错误。

### 阶段审查

- 审查对象为冻结 diff，不审查仍可能继续写入的工作区；
- 实现代理不得替代独立只读审查；
- 所有子代理进入终态后才能交付；
- 审查发现由主 Agent 判断是否修复，修复后只重跑受影响验证并重新冻结 diff。

## 6. 非目标与风险

本调度不改变以下边界：

- 不修改 Relay、Pi Extension、Protocol v2、IndexedDB 数据模型或生产部署契约；
- 不把 Browser Mode 作为 Playwright `/app` E2E 或真实设备验收的替代品；
- 不为 Settings 保存失败擅自定义新的 UI、回滚或错误展示语义；
- 不为真实 QR 摄像头、Service Worker lifecycle、Standalone 和软键盘能力制造虚假的组件测试结论；
- 不因 Plan 66 后续结构拆分而阻塞当前 Plan 67 已完成的 Browser 测试建设；
- 不因测试迁移而一次性重写全部 legacy 测试。

剩余已知风险和真实设备边界，以 Plan 66、Plan 67 及项目技能中的专项记录为准。

## 7. 后续更新规则

阶段完成时按以下顺序更新：

1. 先把仍有效的技术事实同步到 Plan 66 或 Plan 67 的对应章节；
2. 再在本文档更新阶段状态、实际提交和验证结果；
3. 最后切换下一阶段，并明确其前置条件；
4. 不在三份文档中重复维护同一份详细测试或实现清单。
