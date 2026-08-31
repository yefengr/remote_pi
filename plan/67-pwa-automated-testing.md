# PWA 自动化测试体系

> 技术状态：Phase 1–4 的技术阶段当前有效；Plan 69 完整真实矩阵仍作为独立最终验收
>
> 创建日期：2026-08-29
>
> 当前核对：2026-08-31；当前执行状态、跨计划顺序和切换门禁以 [Plan 68](68-pwa-ui-quality-roadmap.md) 为唯一真源
>
> 适用范围：`site/` 中的浏览器 PWA。Plan 66/67 原批次不改变 Relay、Pi Extension、Protocol v2 或生产部署契约；Plan 69 已在其独立范围内取代该跨端边界。

## 1. 背景

本计划建立前，Remote Pi PWA 只有两类验证：

1. `node:test + tsx`：覆盖协议、状态机、数据逻辑以及 React 组件的 SSR 静态标记；
2. 人工编排的真实浏览器 smoke：覆盖 Mantine Portal、焦点、Escape、层级和移动布局。

该历史基线能够阻止大量回归，但两层之间缺少可重复执行的客户端组件测试。SSR 测试无法运行 React 客户端生命周期、状态更新、Portal、Transition、真实键盘事件与焦点管理；人工浏览器 smoke 成本较高，也不适合作为每次改动的快速反馈。

确认操作 Modal 迁移已经暴露过以下运行时问题：

- 快速双击可能在 React 下一次 render 前重复执行异步动作；
- 条件卸载 Modal 会使 Mantine 无法观察 `opened: true → false`，导致 `returnFocus` 失效；
- Modal 与底层 Drawer 都在 document capture 阶段监听 Escape，同一次按键可能关闭两层；
- 原菜单项或删除按钮卸载后需要稳定焦点 fallback；
- `390×844` 下按钮文案可能被裁切，且 Mantine Group 样式可能覆盖低特异性的移动 CSS。

这些问题需要真实 DOM、浏览器事件、焦点与 CSS 才能可靠验证。

## 当前检查点

当前实跑结果：

- Vitest Node：33 files、122/122 通过；Browser：11 files、75/75 通过；默认 `pnpm test` 串行覆盖两层；
- coverage：44 files、197/197 个 Vitest tests 通过；Playwright desktop/mobile：10/10 通过；
- 全部 Node 测试专项 ESLint、TypeScript、production build 与 `git diff --check` 通过；
- legacy 测试文件和源码 `node:test` / `node:assert` 导入均为 0；`test:legacy` 已移除；
- Site 不再直接依赖 `tsx`；lock 中仅保留 Vite 的传递可选依赖关系；
- 全量 `pnpm lint` 的唯一 error 是生成文件 `site/public/sw.js` 的 `@typescript-eslint/no-this-alias`；另有生成 coverage、Service Worker 与既有 img warnings。

上述结果是本文件唯一的当前测试快照。下文出现的旧数字均为对应提交时的历史快照，不代表当前值。

## 2. 目标

建立长期可维护的 PWA 自动化测试分层：

1. 用 Vitest 统一新增测试的 API、断言、mock 与 coverage；
2. 使用 Vitest Node 项目运行纯逻辑、协议、数据和 SSR 测试；
3. 使用 Vitest Browser Mode + Playwright Chromium 运行 React 客户端组件测试；
4. 使用 Playwright Test 运行完整 `/app` PWA 流程；
5. 保留真实设备验证，只覆盖浏览器自动化难以可靠模拟的能力；
6. 分批迁移实际盘点出的 31 个 legacy 文件，并修正 1 个仍使用 `node:test` 的伪 Vitest Node 文件，不进行一次性重写；
7. 让本地、Agent 和后续 CI 使用相同的稳定命令。

## 3. 非目标

本方案不包含：

- 修改 PWA 业务行为、协议字段、IndexedDB 数据模型或 Relay；
- 一次性把所有 `node:test` 测试迁移到 Vitest；
- 用组件测试替代真实浏览器 E2E 或真实设备验证；
- 在首阶段追求全仓固定覆盖率百分比；
- 在非 PWA 的 Landing、Docs、Tutorials 和 Legal 页面建立同等测试矩阵；
- 自动执行生产发布、真实用户数据删除或生产清库。

## 4. 已决定的测试架构

```text
┌────────────────────────────────────────────┐
│ 真实设备验收                               │
│ Safari / Standalone / 摄像头 / 软键盘      │
├────────────────────────────────────────────┤
│ Playwright E2E                             │
│ /app、IndexedDB、Service Worker、完整流程  │
├────────────────────────────────────────────┤
│ Vitest Browser Mode + Chromium             │
│ React、Mantine、Portal、焦点、事件、CSS     │
├────────────────────────────────────────────┤
│ Vitest Node                                │
│ 协议、状态机、纯函数、数据逻辑、SSR         │
└────────────────────────────────────────────┘
```

### 4.1 Vitest Node

负责：

- Protocol v2 解析与不变量；
- Timeline、Reconnect、Recovery 等状态机；
- 数据转换、编码、加密与纯函数；
- Dexie 之外的确定性数据逻辑；
- React SSR 初始结构、文案、ARIA 与 disabled 属性；
- 不依赖真实浏览器布局的异步协调逻辑。

### 4.2 Vitest Browser Mode

使用 Playwright provider 在真实 Chromium 中运行组件测试，负责：

- React 客户端 state/effect 生命周期；
- Mantine Modal、Drawer、Menu、Popover 和 Portal；
- 键盘、鼠标和焦点传播；
- `document.activeElement` 与 `returnFocus`；
- Overlay Escape 竞争；
- Transition 完成回调；
- CSS media query、computed style、元素 rect 和溢出；
- 浏览器提供的基础 API mock。

Browser Mode 是 PWA 组件测试的主 DOM 环境。首阶段不引入 jsdom 或 happy-dom。

### 4.3 Playwright E2E

负责完整应用行为：

- `/app` 启动；
- PWA Provider 和路由集成；
- IndexedDB 隔离数据；
- Settings、Session Drawer、Composer 与确认流程；
- 页面刷新后的本地状态；
- Service Worker 注册与更新的可自动化部分；
- Desktop 与移动 viewport；
- 后续与测试 Relay/Pi 的真实 Protocol v2 链路。

### 4.4 真实设备验证

继续保留：

- Safari/Chrome Standalone PWA；
- 摄像头真实授权与切换；
- 移动软键盘、地址栏、旋转和安全区；
- OS 安装提示；
- 真实 Service Worker waiting worker 时序。

## 5. 技术选型

首阶段使用以下开发依赖，实施时应再次核对最新兼容版本并固定精确版本：

```text
vitest@4.1.11
@vitest/browser-playwright@4.1.11
vitest-browser-react@2.2.0
playwright@1.62.1
@vitejs/plugin-react@6.1.1
@vitest/coverage-v8@4.1.11
```

约束：

- `vitest` 与 `@vitest/browser-playwright` 必须使用完全相同的版本；
- `vitest-browser-react` 必须支持 React 19；
- Playwright 必须支持项目当前 Node 版本；
- 本机优先复用 Playwright 浏览器缓存，CI 显式安装 Chromium；
- 首阶段不添加 `jsdom`、`happy-dom`、`@testing-library/react`、`@testing-library/user-event` 或 `@testing-library/jest-dom`；
- Browser Mode 使用 `vitest-browser-react`、`vitest/browser` 的 `page`/`userEvent` 和 `expect.element()`。

参考依据：

- Next.js 官方支持 Vitest 与 React Testing Library 进行同步 Server/Client Component 单元测试；Async Server Component 仍建议 E2E；
- Vitest 官方推荐 Browser Mode 进行真实浏览器组件测试；
- Mantine Portal/Transition 组件需要交互式测试，不能只依赖 SSR 标记。

## 6. 文件与命名约定

目标结构：

```text
site/
├── vitest.config.ts
├── playwright.config.ts                  # Phase 4
├── e2e/                                  # Phase 4
│   └── *.spec.ts
└── src/
    ├── test/
    │   ├── browser/
    │   │   ├── setup.ts
    │   │   └── render.tsx
    │   └── node/
    │       └── setup.ts
    ├── components/pwa/
    │   ├── *.node.test.tsx
    │   └── *.browser.test.tsx
    └── lib/
        └── **/*.node.test.ts
```

命名规则：

- `*.node.test.ts` / `*.node.test.tsx`：Vitest Node；
- `*.browser.test.tsx`：Vitest Browser Mode；
- `e2e/*.spec.ts`：Playwright Test；
- Site 的 Node/SSR 测试不再使用无环境后缀的 `*.test.ts` / `*.test.tsx`；
- 新测试不得使用 `node:test` API。

## 7. Vitest 配置要求

使用 Vitest 4 的 `test.projects`，不使用已弃用的 workspace 配置。配置必须包含：

- React Vite plugin；
- `@` → `site/src` alias；
- `node` 与 `browser` 两个项目；
- Browser Playwright provider；
- Chromium headless 实例；
- 默认 Desktop viewport；
- 分离的 setup files；
- 明确 include glob，避免同一个测试被两个环境重复执行；
- 失败截图目录和稳定超时；
- TypeScript 对 `vitest/browser` 的类型支持。

示意配置：

```ts
import path from "node:path";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.node.test.{ts,tsx}"],
          setupFiles: ["src/test/node/setup.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          setupFiles: ["src/test/browser/setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [
              {
                browser: "chromium",
                viewport: { width: 1280, height: 900 },
              },
            ],
          },
        },
      },
    ],
  },
});
```

实施时以安装后的 Vitest 4.1.x 类型定义和 CLI 行为为准，不机械复制示意配置。

## 8. Browser 测试基础设施

### 8.1 统一渲染器

`src/test/browser/render.tsx` 提供统一的 PWA render helper：

- 包装 `PwaUiProvider`；
- 创建 `.pwa-root` Portal target；
- 创建必要的 `.pwa-ui-scope`；
- 每个测试自动清理 Portal 和 DOM；
- 允许传入测试 Harness，而不是强制挂载完整 `PwaApp`。

示意：

```tsx
export async function renderPwa(ui: React.ReactNode) {
  return render(
    <PwaUiProvider>
      <div className="pwa-root">{ui}</div>
    </PwaUiProvider>,
  );
}
```

### 8.2 样式

Browser setup 必须加载：

```ts
import "@mantine/core/styles.css";
import "@/app/globals.css";
```

`globals.css` 使用 Tailwind 4 的 `@import "tailwindcss"` 和 `@theme inline`。Vitest/Vite 必须正确使用项目现有 `postcss.config.mjs`。验收不能只检查 CSS import 没有报错，还必须断言：

- PWA token 实际存在；
- Modal/Drawer computed style 正确；
- `390×844` media query 生效；
- `.pwa-confirm-actions` 的 computed `flex-direction` 为 `column`。

### 8.3 浏览器 API

只 mock 组件契约要求的 API。候选包括：

- `matchMedia`；
- `ResizeObserver`；
- `IntersectionObserver`；
- `URL.createObjectURL` / `URL.revokeObjectURL`；
- Clipboard；
- camera/mediaDevices；
- Service Worker registration；
- WebSocket/Relay boundary。

不要在全局 setup 中过度 mock。优先在测试文件或专项 helper 中按需安装与恢复。

## 9. 首批 Browser Mode 测试

Phase 1 以确认操作为试点。

### 9.1 `ConfirmActionDialog`

新建：

```text
site/src/components/pwa/confirm-action-dialog.browser.test.tsx
```

覆盖：

1. 同一个组件树执行 `action=null → action=new-session → action=null`；
2. 打开后存在可访问 Dialog、标题、描述和确认按钮；
3. Escape 和 Cancel 关闭；
4. 显式聚焦触发器后打开，关闭时焦点返回；
5. pending 时 Confirm、Cancel、Close 禁用；
6. pending 时 Escape 和遮罩点击不关闭；
7. error 使用 `role="alert"`，Dialog 保持打开；
8. pending 结束后可以重试。

### 9.2 Settings + Confirm Harness

使用小型测试 Harness 覆盖：

1. Settings Drawer 打开确认 Modal；
2. 第一次 Escape 只关闭 Modal；
3. Drawer 保留；
4. 焦点返回 `Clear local data`；
5. 第二次 Escape 关闭 Drawer；
6. Modal z-index 高于 Drawer。

不要为了覆盖 Overlay 协调而完整挂载依赖 Relay、Dexie 和 Service Worker 的 `PwaApp`。

### 9.3 Session Drawer + Confirm Harness

覆盖：

1. 从删除按钮打开确认；
2. Escape/Cancel 后 Drawer 保留；
3. 原按钮存在时返回原按钮；
4. 模拟删除成功使原按钮卸载；
5. 焦点按契约 fallback 到 Drawer Close、剩余 Pairing 或 Session switcher。

### 9.4 移动布局

使用真实 Chromium `390×844` viewport 断言：

- Dialog rect 完全位于 viewport；
- Action group computed `flex-direction: column`；
- 两个按钮全宽且宽度一致；
- 按钮 `scrollWidth <= clientWidth`；
- Dialog 没有横向溢出；
- 标题、描述和操作文案完整可见。

## 10. 后续 Browser Mode 迁移顺序

按运行时风险排序：

1. `rename-pairing-dialog`：自动 focus/select、Enter、Escape、失败保持；
2. `message-composer`：Menu、互斥、focus return、hidden input、Stop/Send；
3. `session-sheet`：Drawer、offline Session、Pairing 操作；
4. `settings-panel`：Save、Reset layout、Clear confirmation；
5. `mobile-topbar-menu`：Menu 打开/关闭和焦点；
6. `qr-scanner`：文件入口、close/cleanup 和 camera mock；
7. `service-worker-register`：UI 状态；真实 SW lifecycle 保留在 E2E。

SSR 测试继续覆盖初始结构，但不得把 SSR 断言表述为客户端交互覆盖。

## 11. 现有 Node 测试迁移

历史基线（计划创建时快照，非当前值）：

- 18 个 `.test.ts`；
- 14 个 `.test.tsx`；
- 共 32 个测试文件。

最终盘点与完成结果：31 个 legacy 文件、1 个仍使用 `node:test` 的 `protocol.node.test.ts` 与 1 个既有真实 Vitest 文件；迁移后统一为 33 个 Vitest Node 文件、122 个 tests。

### 11.1 迁移阶段

#### 阶段 A：并存

- 保留现有 `node:test + tsx` 命令；
- Vitest 只运行新建的 `*.node.test.*` 和 `*.browser.test.tsx`；
- 项目默认 `test` 同时执行 legacy 与新 Browser tests。

#### 阶段 B：纯 TypeScript

优先把 `src/lib/**/*.test.ts` 迁移为 `*.node.test.ts`，将：

```ts
import test from "node:test";
import assert from "node:assert/strict";
```

替换为 Vitest 的：

```ts
import { describe, expect, test, vi } from "vitest";
```

不改变协议和状态机断言语义。

#### 阶段 C：SSR 组件

把需要保留的 SSR 测试迁移为 `*.node.test.tsx`，继续使用 `renderToStaticMarkup`，仅覆盖：

- 初始结构；
- 文案与标记；
- ARIA；
- disabled；
- 服务端渲染安全。

交互断言移入对应 `*.browser.test.tsx`。

#### 阶段 D：移除 legacy runner

所有测试迁移并通过后：

- 删除 legacy `node --test --import tsx` script；
- 检查 `tsx` 是否仍有其他消费者，再决定是否移除依赖；
- 默认 `pnpm test` 只运行 Vitest Node 与 Browser 项目。

## 12. Playwright E2E

Phase 4 新建：

```text
site/playwright.config.ts
site/e2e/pwa-startup.spec.ts
site/e2e/pwa-settings.spec.ts
```

首批 E2E：

1. 启动 `/app`；
2. 使用隔离 browser context；
3. 在测试 origin 的 IndexedDB 注入临时 Pairing/Room；
4. 打开 Settings 和 Session Drawer；
5. 打开/取消确认 Modal；
6. 安全执行删除或清库，并验证刷新后的状态；
7. 验证 Service Worker 是否注册；
8. Desktop 和移动 viewport；
9. 不使用真实用户数据或生产 origin。

后续把已有真实 Relay/Pi 的 Protocol v2 E2E 接到 Playwright Test，但保持为独立、环境敏感的测试项目。

## 13. Package scripts

迁移期建议：

```json
{
  "scripts": {
    "test": "pnpm test:legacy && pnpm test:component",
    "test:legacy": "node --test --import tsx <现有 globs>",
    "test:unit": "vitest run --project node",
    "test:component": "vitest run --project browser",
    "test:component:watch": "vitest --project browser",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:coverage": "vitest run --coverage"
  }
}
```

完成迁移后：

```json
{
  "scripts": {
    "test": "pnpm test:unit && pnpm test:component"
  }
}
```

实施时应把现有分散在 Agent 命令中的测试 glob 收敛到 `site/package.json`，让本地、Agent 和后续 CI 使用同一入口。

## 14. CI 门禁

仓库当前没有已登记的 GitHub Actions 工作流。建立 CI 时按职责拆分：

### 14.1 快速测试

每次 Pull Request：

```bash
pnpm test:unit
pnpm test:component
pnpm exec tsc --noEmit
pnpm lint
```

### 14.2 Production build

每次 Pull Request：

```bash
pnpm build
```

### 14.3 E2E

- Pull Request：Chromium；
- main 或 nightly：WebKit；
- 真实 Relay/Pi：环境可用时单独执行；
- CI 安装 Chromium：

```bash
pnpm exec playwright install --with-deps chromium
```

本机 macOS 使用 Playwright 用户缓存，不在每次测试前重新安装浏览器。

## 15. Coverage 策略

首阶段接入 `@vitest/coverage-v8`，但不设置全局百分比门槛。

初始排除候选：

```text
src/app/**
public/**
*.config.*
src/**/*.browser.test.*
src/**/*.node.test.*
```

重点观察：

- 从 `PwaApp` 提取的 controller/helper；
- 状态机；
- 确认协调器；
- Timeline、Reconnect、Recovery；
- Protocol v2。

稳定后再设置增量门禁：

- 新增纯逻辑代码需要合理覆盖；
- 不先要求所有 React 视图达到统一百分比；
- 不为追求覆盖率编写无行为价值的测试。

## 16. 分阶段实施

### Phase 1：基础设施与确认 Modal 试点

**技术状态：基础设施与试点已实现**

预计修改：

```text
site/package.json
site/pnpm-lock.yaml
site/vitest.config.ts
site/src/test/browser/setup.ts
site/src/test/browser/render.tsx
site/src/test/node/setup.ts
site/src/components/pwa/confirm-action-dialog.browser.test.tsx
site/CLAUDE.md
```

必要时新增 Overlay 测试 Harness。若 Harness 只服务测试，放入 `site/src/test/browser/fixtures/`，不得污染生产业务组件。

验收：

- Vitest Browser Mode 在真实 Chromium 中启动；
- `@` alias、React JSX、Mantine Provider 和 PWA Portal 工作；
- Tailwind/PWA CSS 的 computed style 断言通过；
- 确认 Modal 生命周期、焦点、Escape、pending、error 和移动布局通过；
- 现有 legacy 测试全部通过；
- TypeScript、受影响 ESLint、production build 和 `git diff --check` 通过；
- 记录 Browser Mode 首次执行时间和稳定性。

### Phase 2：高风险交互组件

**技术状态：高风险交互组件的 Browser 覆盖已实现**

迁移 Rename、Settings、Session Drawer、Composer Menu 和 Mobile Menu 的客户端交互测试。

验收：

- 对应人工 browser smoke 场景已有自动化组件覆盖；
- Browser 调用次数和交互返工减少；
- 真实浏览器 smoke 仍验证集成与视觉，不重复组件内部所有状态。

### Phase 3：统一 Node 测试 API

**技术状态：已完成；执行顺序以 Plan 68 为准**

31 个 legacy Node/SSR 文件与 `protocol.node.test.ts` 已分批迁移到 Vitest Node，测试语义与总量保持为 122；源码不再导入 `node:test` / `node:assert`。legacy runner 已移除，默认 `pnpm test` 串行运行 Vitest Node 与 Browser；Site 对 `tsx` 的直接依赖已删除。

验收：

- 每批迁移前后测试数量和行为一致，并明确 legacy、Vitest Node、Browser 三层各自数量；
- 不改变 Protocol v2 fixture 语义；
- `test:unit` 纳入默认 `pnpm test` 前，不能宣称默认测试覆盖所有测试层；
- 所有 legacy 测试迁完后移除旧 runner。

### Phase 4：Playwright E2E

**技术状态：基础 E2E 已实现**

已建立隔离 `/app` E2E、IndexedDB fixture 和 Service Worker 流程。当前 Playwright desktop/mobile 10/10 的通过结果见“当前检查点”；此前阶段记录中的 E2E 数字均为对应提交时的历史快照。

验收：

- Chromium E2E 稳定运行；
- 数据隔离且可安全执行破坏性确认；
- 后续接入 WebKit 和真实 Relay/Pi。

## 17. 自动化与人工验收边界

| 行为 | Node | Browser Mode | Playwright E2E | 真实设备 |
|---|---:|---:|---:|---:|
| 协议/状态机 | ✓ |  |  |  |
| SSR 标记/ARIA | ✓ |  |  |  |
| React state/effect |  | ✓ | ✓ |  |
| Portal/焦点/Escape |  | ✓ | ✓ |  |
| CSS/computed layout |  | ✓ | ✓ | ✓ |
| IndexedDB 完整流程 |  | 可 mock | ✓ |  |
| Service Worker |  | UI mock | ✓ | ✓ |
| Relay/Pi |  | boundary mock | ✓ | ✓ |
| 摄像头真实授权 |  | mock | 有限 | ✓ |
| Standalone/软键盘 |  |  | 有限 | ✓ |

## 18. 风险与缓解

### 18.1 Browser Mode 配置复杂度

风险：Vite、Next.js、Tailwind PostCSS、路径 alias 和 Mantine Portal 可能需要兼容配置。

缓解：Phase 1 只做确认 Modal 试点；用实际 computed style 和 Portal 断言证明环境真实可用。

### 18.2 浏览器测试变慢或不稳定

风险：真实 Chromium 比 Node 慢，Transition 和异步 locator 可能产生 flaky tests。

缓解：

- 组件测试使用小型 Harness；
- 使用 Vitest locator 和 `expect.element()` 的自动重试；
- 不使用任意 sleep；
- 只在 Browser Mode 放必须依赖真实 DOM 的行为；
- 保持 Node 层覆盖大多数纯逻辑。

### 18.3 两套 runner 的迁移期维护

历史风险已解除：legacy `node:test` runner 已移除，Node/SSR 测试统一由 Vitest Node 执行，默认 `pnpm test` 串行覆盖 Node 与 Browser。

### 18.4 重复覆盖

风险：SSR、Browser 和 E2E 对同一文案或按钮做重复断言。

缓解：每层只覆盖其独有风险；共享关键 happy path 可以重复，但边界状态只在最低可靠层测试。

### 18.5 Playwright 浏览器资源

风险：CI 下载和缓存体积增加。

缓解：PR 默认只安装 Chromium；WebKit 放 main/nightly；本机复用用户缓存。

## 19. 完成标准

本方案整体完成需要满足：

- 新增组件交互测试统一使用 Vitest Browser Mode；
- 现有 Node 测试统一迁移到 Vitest Node，legacy `node:test` 入口已移除；
- 默认 `pnpm test` 纳入 Vitest Node 与 Browser，Package scripts 成为本地、Agent 和 CI 的单一测试入口；
- PWA 核心 Overlay、Composer、Session、Settings 和 QR UI 有 Browser Mode 覆盖；
- `/app` 隔离 Playwright E2E 保持可运行；
- Production build 与现有真实 Relay/Pi 验收继续保留；Plan 69 的 daemon、两个 interactive Pi、双 PWA profile、supervisor/child crash、runtime takeover 与 `/new` 完整真实矩阵须作为独立的最终跨端验收完成，不能由本计划的组件或基础 E2E 替代；
- 测试层职责和剩余真实设备风险在 `site/CLAUDE.md` 中保持简明、准确。

## 20. Phase 3 技术检查清单

Phase 1 的原始检查项已完成，不能再作为当前待办。当前执行状态、跨计划顺序和切换门禁只在 Plan 68 维护；以下仅是本计划 Phase 3 的技术检查项。

- [x] 盘点 31 个 legacy 文件与 2 个 `*.node.test.ts` 的实际 runner、测试数和直接 scripts 消费者；
- [x] 将 `protocol.node.test.ts` 的 runner/API 迁移为真实 Vitest Node，且不改变 3 个 cases 的语义；
- [x] 每个批次记录迁移前后的分层测试数量，避免把历史快照当作当前值；
- [x] 在修改默认测试入口前，确认 `test:unit` 的可靠运行及与 Browser/legacy 的组合顺序；
- [x] 迁移全部现有 legacy Node/SSR 测试后移除 legacy runner，并让默认 `pnpm test` 串行覆盖 Vitest Node 与 Browser；
- [x] 运行受影响层验证，并保留全量 lint 的生成文件 error 与既有 warnings 的区分。
