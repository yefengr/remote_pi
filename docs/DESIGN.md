---
version: 1
name: Remote Pi PWA — 现行深色天蓝基线
description: 当前实现的设计映射；素靛双主题仍是独立待实施方案，本文件不重新作出主题取舍。
sources:
  css: pwa/src/app/globals.css
  theme: pwa/src/lib/ui/remote-pi-theme.ts
  fonts: pwa/src/app/layout.tsx
  provider: pwa/src/components/pwa/pwa-ui-provider.tsx
colors:
  global-bg: "#000000"
  global-ink: "#ffffff"
  global-muted: "#a3a3a3"
  global-accent: "#4fc3f7"
  global-success: "#5fd38a"
  pwa-ink: "#f4f8f9"
  pwa-dim: "#8d9a9e"
  pwa-accent: "#4fc3f7"
  pwa-success: "#73e2a4"
  pwa-danger: "#ff6b6b"
surfaces:
  global-card: "rgba(255, 255, 255, 0.025)"
  global-line: "rgba(255, 255, 255, 0.1)"
  pwa-line: "rgba(255, 255, 255, 0.09)"
  pwa-line-strong: "rgba(255, 255, 255, 0.16)"
typography:
  body-base:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: "400"
    lineHeight: "1.6"
rounded:
  css:
    sm: "12px"
    md: "18px"
    lg: "26px"
    xl: "34px"
  mantine:
    xs: "5px"
    sm: "8px"
    md: "10px"
    lg: "13px"
    xl: "18px"
spacing:
  model: "component-local; no unified scale"
  mobile-content-padding-inline: "16px"
components:
  wrappers: "Button, IconButton, Input, Textarea, Select, Badge, Tooltip"
  provider: "MantineProvider: forceColorScheme=dark; cssVariablesSelector=.pwa-ui-scope"
  primary: "{colors.pwa-accent}"
---

# Remote Pi PWA 设计基线

## Overview

当前 PWA 采用黑底、深色表面和天蓝强调色，仅启用深色模式。[PWA UI Provider](../pwa/src/components/pwa/pwa-ui-provider.tsx) 设置 `forceColorScheme="dark"`，[全局样式](../pwa/src/app/globals.css) 声明 `color-scheme: dark`。主题中同时出现 `primaryShade.light` 与 `primaryShade.dark`，不代表产品已经支持主题切换。

这份文档供 PWA 开发者与维护者定位现行视觉规则和组件边界。frontmatter 是源码值的设计映射，不是第二套独立数值定义；实际定义仍以 CSS 和主题配置为准，来源变化时应同步这里的说明。模块职责与运行关系见 [ARCHITECTURE.md](ARCHITECTURE.md)。

素靛双主题仍是已确认、待实施的目标设计，没有因建立现行基线而被取消，也尚未成为当前实现。设计内容见[主题方案](plans/active/20260830-pwa-theme.md)和[主题原型](prototypes/20260830-pwa-theme.html)，实施状态统一查阅 [ROADMAP.md](ROADMAP.md)。原型用于方案评审，不是生产组件或现行实现真源；历史对比度表也不代表当前界面已经通过对应验收。

## Colors

颜色定义分为三个作用域，使用时先确定组件由哪一层控制，而不是只看 token 名称。

| 作用域 | 定义来源 | 使用边界 |
| --- | --- | --- |
| 全局 CSS token | [globals.css](../pwa/src/app/globals.css) | 黑色背景、基础文字、卡片、分隔线与全局强调色 |
| PWA 局部 token | 同一文件中的 PWA 定义 | PWA 文字、弱化文字、状态色和局部分隔线 |
| Mantine 调色板 | [remote-pi-theme.ts](../pwa/src/lib/ui/remote-pi-theme.ts) | `remotePi` 色阶与 Mantine 组件的主题映射 |

旧 `--green*` 命名实际指向天蓝色系，强调色为 `#4fc3f7`；PWA 的 `--pwa-green` 才是绿色 `#73e2a4`。全局与 PWA 的 success、line 也不是相同值，不能因语义相近就互换。带透明度的表面和边线值单独记录在 frontmatter 的 `surfaces` 中。

Mantine 的 `remotePi` 是完整色阶，不是单一强调色。其 shade 5 为 `#2db5ef`；组件的最终颜色还受 shade、variant 与局部样式影响，不能将所有按钮背景一概记为 `#4fc3f7`。完整色阶保留在主题源码中，不在这里另建一张需要同步维护的表。

## Typography

字体由 [layout.tsx](../pwa/src/app/layout.tsx) 通过 `next/font` 加载，均使用 `display: swap` 和 `latin` subset。

| 字体 | 已加载字重 | 映射 |
| --- | --- | --- |
| Hanken Grotesk | 400、500、600 | 正文字体 `--ff-body` |
| Space Grotesk | 500、600、700 | 展示字体 `--ff-display` |
| JetBrains Mono | 400、500 | 等宽字体 `--ff-mono` |

[globals.css](../pwa/src/app/globals.css) 将这些 token 连接到 `next/font` 变量；[Mantine 主题](../pwa/src/lib/ui/remote-pi-theme.ts) 再分别映射到 `fontFamily`、`headings` 和 `fontFamilyMonospace`。

frontmatter 中的 `17px`、字重 `400` 和行高 `1.6` 只是 body 的默认基值。正文、消息、品牌和代码区域仍有组件级字号覆写，不能把这个基值当作所有消息或控件的统一排版规格。

## Layout

[globals.css](../pwa/src/app/globals.css) 中的 `.pwa-root` 使用 `height: 100dvh` 和 `overflow: hidden`，消息列表承担滚动。桌面网格为 `minmax(250px, 320px) minmax(0, 1fr)`，分别容纳侧栏与主内容。

在 `max-width: 760px` 的断点下，布局切换为单栏，并隐藏 sidebar 与 chathead。移动端消息区和 composer 的横向内边距为 `16px`，同时使用 safe-area `env()` 适配安全区域。调整布局时，应一起检查消息滚动、输入区、窄屏溢出与安全区域，而不是只看桌面静态画面。

当前间距由组件局部定义，没有统一的全局 `8px` spacing scale。项目 `IconButton` 有明确的 `44px` 尺寸样式，但这不能证明所有原生 button 都达到该尺寸；新改控件仍需按实际影响检查触控区域与响应式表现。

## Elevation & Depth

当前 `.pwa-root` 保留 `#050708 → #070a0c → #050607` 的暗渐变与天蓝光晕。半透明表面、普通边线和较强边线共同形成层次；渐变仍属于现行表现，不能用未来主题的目标要求替换对当前实现的描述。

叠层的深度处理需要结合具体组件理解。[确认对话框](../pwa/src/components/pwa/confirm-action-dialog.tsx)的 Modal 和[设置面板](../pwa/src/components/pwa/settings-panel.tsx)的 Drawer 使用 `overlayProps`，其中 `backgroundOpacity` 为 `0.74`、`blur` 为 `10`。这是有来源的组件配置，不是一套覆盖整个 PWA 的统一阴影表。

## Shapes

圆角有两套作用域：[CSS](../pwa/src/app/globals.css) 定义 `--r-sm`、`--r-md`、`--r-lg`、`--r-xl`；[Mantine 主题](../pwa/src/lib/ui/remote-pi-theme.ts) 定义 `xs` 至 `xl` 五档，并以 `sm` 作为 `defaultRadius`。具体值已映射到 frontmatter；两边同名的 `sm` 并不等价，使用时须保留作用域。

项目 `IconButton` 另有显式 `10px` 圆角，round 形式使用 `50%`，其他组件也可能局部覆写。维护时应查看最终生效样式，不把局部规则误当作全局 token，也不因整理文档而顺带统一两套圆角定义。

## Components

现有 UI 包装层包括 `Button`、`IconButton`、`Input`、`Textarea`、`Select`、`Badge` 和 `Tooltip`。它们按组件需要透传 Mantine props，并补充项目 class 或默认值；例如 `Button` 增加 `pwa-button`、`data-tone` 和默认 size、variant，但不是每个 wrapper 都具有全部这些属性。职责是承接项目样式与默认值，不是包装全部 Mantine API，也不复制 overlay 行为。

[PWA UI Provider](../pwa/src/components/pwa/pwa-ui-provider.tsx) 将 Mantine CSS 变量限定到 `.pwa-ui-scope`。业务组件直接使用 Mantine 的 Modal、Drawer、Menu、Popover；选择 Portal 挂载点时，需要同时保留主题 scope 和既有父子叠层关系。

| 源码入口 | 当前需要保留的行为 |
| --- | --- |
| [confirm-action-dialog.tsx](../pwa/src/components/pwa/confirm-action-dialog.tsx) | Modal 启用 Portal 时以 `.pwa-root` 为目标，`zIndex` 为 `310`，启用 `trapFocus` 与 `returnFocus`；pending 时禁止 Escape 和点击外侧关闭 |
| [settings-panel.tsx](../pwa/src/components/pwa/settings-panel.tsx) | Drawer 的 Portal 目标为 `.pwa-root` |
| [rename-pairing-dialog.tsx](../pwa/src/components/pwa/rename-pairing-dialog.tsx) | 使用 `withinPortal={false}`，启用 `trapFocus` 与 `returnFocus`；saving 时禁止关闭 |

Portal 不是一律挂载到 `document.body`，也不是所有 overlay 都统一挂载到 `.pwa-root`。[PwaApp](../pwa/src/components/pwa/pwa-app.tsx) 中的配对 backdrop 仍是自有实现，不能将整个 PWA 描述为全部使用 Mantine overlay，或推定所有位置都具备焦点陷阱。

变更叠层时，应按项目 overlay 验证技能检查父子叠层、焦点恢复、Escape 竞争、滚动和样式 scope。这些是后续维护边界，不是本次文档补齐已完成 UI 行为验收的声明；截图和静态文档不能替代行为验证。

## Do's and Don'ts

- 复用有源码依据的现行组件和 token；修改来源时同步设计映射与说明。尚无统一定义的内容，记录真实作用域，不补造一套 token。
- 将现行实现、已确认目标设计和历史材料分开使用。未来原型不能作为当前组件已实现的证据，设计文档也不替代 ROADMAP 的事项状态。
- 对比度、触控和焦点结论必须有对应验证依据，不笼统宣称 WCAG 全部通过、所有控件均为 `44px` 或产品已支持双主题。
- 文档整理不构成修改生产主题、重构组件或更换品牌的授权；此类变更须另行确认范围。
