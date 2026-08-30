---
version: 1
name: Remote Pi PWA Theme — 素靛 Paper & Indigo
description: PWA 双主题设计真源（浅色基准 / 深色跟随）。2026-08-30 定稿，尚未落地实现。
colors:
  bg-0-light: "#FFFFFF"
  card-light: "#FFFFFF"
  surface-1-light: "#F7F7F8"
  surface-hover-light: "#F4F4F5"
  user-bubble-light: "#F1F2F4"
  ink-light: "#1B1B1F"
  ink-soft-light: "#4B4B52"
  muted-light: "#71717A"
  accent-fill-light: "#3A5A8C"
  accent-text-light: "#2C4A78"
  on-accent-light: "#FFFFFF"
  approval-bg-light: "#F2F5F9"
  reject-bg-light: "#F4F4F5"
  running-light: "#B45309"
  success-light: "#2E7D32"
  error-light: "#C62828"
  offline-light: "#75757E"
  code-bg-light: "#23262E"
  code-ink-light: "#E6E8ED"
  bg-0-dark: "#1C1C1E"
  card-dark: "#2A2A2E"
  surface-1-dark: "#242427"
  surface-hover-dark: "#333338"
  user-bubble-dark: "#3A3A40"
  ink-dark: "#F2F2F4"
  ink-soft-dark: "#D2D2D8"
  muted-dark: "#9B9BA3"
  accent-fill-dark: "#82A7D6"
  accent-text-dark: "#82A7D6"
  on-accent-dark: "#0F1D33"
  approval-bg-dark: "#2A2A2E"
  reject-bg-dark: "#333338"
  running-dark: "#E8A04C"
  success-dark: "#81C784"
  error-dark: "#E57373"
  offline-dark: "#8A8A92"
  code-bg-dark: "#16171B"
  code-ink-dark: "#DEE1E7"
typography:
  sans:
    fontFamily: "Manrope, -apple-system, PingFang SC, Noto Sans SC, sans-serif"
    fontSize: "14.5px"
    fontWeight: "400–700"
    lineHeight: "1.55"
  brand-serif:
    fontFamily: "Source Serif 4, Noto Serif SC, Songti SC, serif"
    fontSize: "19–21px"
    fontWeight: "600"
    lineHeight: "1.4"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: "400–500"
    lineHeight: "1.6"
rounded:
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "22px"
  pill: "999px"
spacing:
  scale: "4 / 8 / 12 / 16 / 20 / 24（8px 网格）"
components:
  message-bubbles: "用户淡底 / agent 白卡，非对称大圆角"
  approval-card: "accent 描边 + tint 底，46px 操作按钮"
  code-block: "恒深色卡片，mono 呈现"
  session-chips: "pill 形会话切换，44px 触控目标"
  composer: "胶囊输入框 + 圆形发送钮"
  statusbar-theme-color: "浅 #FFFFFF / 深 #1C1C1E"
---

# DESIGN.md — PWA 主题设计真源

## Overview

Remote Pi PWA 的双主题设计（浅色为设计基准，深色为跟随映射）。定稿名「素靛 Paper & Indigo」：纯净白底 × 靛蓝 accent，柔和 AI 对话产品质感。

设计共识（2026-08-30 访谈收敛）：

- 参照气质为 ChatGPT / Claude / Codex 一类柔和 AI 对话产品，明确拒绝终端/CRT 隐喻与开发者工具高对比风
- 双主题都做，浅色为设计基准，深色跟随
- 界面全无衬线；品牌层（空态、onboarding、营销标题）用衬线点缀
- 大圆角、细微表面分层、大面积留白
- accent 为靛蓝双色：浅色填充 `#3A5A8C` / 文字 `#2C4A78`；深色统一 `#82A7D6`
- running 状态保留琥珀橙（用户终审确认），语义分工：靛蓝 = 用户操作，橙 = agent 活动

可评审原型（已确认）：`prototypes/20260830-pwa-theme.html`

## Colors

### 浅色（设计基准）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-0` | `#FFFFFF` | 主底 |
| `--card` | `#FFFFFF` | 卡片（靠边框 + 阴影分层） |
| `--surface-1` | `#F7F7F8` | 次级表面（顶栏、代码块头部区） |
| `--surface-hover` | `#F4F4F5` | hover 态 |
| `--user-bubble` | `#F1F2F4` | 用户消息气泡底 |
| `--line` | `rgba(24,24,27,0.10)` | 常规描边 |
| `--line-strong` | `rgba(24,24,27,0.18)` | 强描边 |
| `--ink` | `#1B1B1F` | 主文字 |
| `--ink-soft` | `#4B4B52` | 次级文字 |
| `--muted` | `#71717A` | 辅助文字 |
| `--accent-fill` | `#3A5A8C` | 主按钮 / 发送 / 批准 |
| `--accent-text` | `#2C4A78` | 链接 / 强调文字 |
| `--on-accent` | `#FFFFFF` | accent 上的文字 |
| `--approval-bg` | `#F2F5F9` | 审批卡底 |
| `--running` | `#B45309` | agent 运行中 |
| `--success` | `#2E7D32` | 成功 |
| `--error` | `#C62828` | 错误 |
| `--offline` | `#75757E` | 离线（图形级） |
| `--code-bg` | `#23262E` | 代码块（恒深色） |

### 深色（跟随映射）

| Token | 值 |
|---|---|
| `--bg-0` | `#1C1C1E` |
| `--card` | `#2A2A2E` |
| `--surface-1` | `#242427` |
| `--surface-hover` | `#333338` |
| `--user-bubble` | `#3A3A40` |
| `--line` | `rgba(242,242,244,0.10)` |
| `--line-strong` | `rgba(242,242,244,0.20)` |
| `--ink` | `#F2F2F4` |
| `--ink-soft` | `#D2D2D8` |
| `--muted` | `#9B9BA3` |
| `--accent-fill` / `--accent-text` | `#82A7D6` |
| `--on-accent` | `#0F1D33` |
| `--approval-bg` | `#2A2A2E` |
| `--running` | `#E8A04C` |
| `--success` | `#81C784` |
| `--error` | `#E57373` |
| `--offline` | `#8A8A92` |
| `--code-bg` | `#16171B` |

### 语义映射

- 靛蓝 = 用户操作：批准按钮、审批卡、链接、选中态、会话标签
- 橙 = agent 活动：运行中 spinner 与指示文字
- 绿 = 成功；红 = 错误；灰 = 离线
- 颜色一律搭配图标，不单独承担语义

### 对比度（WCAG AA，全部通过）

| 组合 | 浅色 | 深色 |
|---|---|---|
| ink / bg-0 | 17.17 | 15.22 |
| muted / bg-0 | 4.83 | 6.17 |
| accent 文字 / bg-0 | 8.91 | 6.84 |
| 按钮字 / accent | 6.95 | 6.79 |
| running / bg-0 | 5.02 | 7.75 |
| success / bg-0 | 5.13 | 8.46 |
| error / bg-0 | 5.62 | 5.70 |

## Typography

- UI 主体：Manrope + 苹方（PingFang SC）/ Noto Sans SC fallback，经 next/font 加载
- 品牌层衬线点缀：Source Serif 4 + 思源宋体（Noto Serif SC），仅标题字重，用于空态、onboarding、营销标题
- Mono：JetBrains Mono，仅代码块、命令、时间戳；不用于标题与正文
- 中文字号体系：正文 14.5–15px / 行高 1.55–1.65；标题 16–17px 加粗收紧字距

## Layout

- 移动优先（390pt 基准），8px 间距网格（4/8/12/16/20/24）
- 会话流单列，左右安全区 padding 16–18px，底部尊重 safe-area
- 内容最大宽度约束沿用站点 `--maxw`
- 触控目标一律 ≥ 44px

## Elevation & Depth

- 浅色：白卡靠双层阴影分层（`0 1px 2px rgba(16,24,40,0.05), 0 1px 3px rgba(16,24,40,0.07)`）+ 细描边
- 深色：靠表面明度抬升（bg `#1C1C1E` → card `#2A2A2E` → hover `#333338`），阴影仅辅助
- 代码块恒为深色卡片（浅 `#23262E` / 深 `#16171B`），浅色界面下保持代码阅读习惯

## Shapes

- 圆角 token：`sm 10px`（小控件）/ `md 14px`（按钮、图标容器）/ `lg 20px`（审批卡）/ `xl 22px`（消息气泡）/ `pill 999px`（会话 chips、输入框、发送钮）
- 气泡非对称圆角：用户消息 `22 22 7 22`，agent 消息 `7 22 22 22`
- 整体大圆角柔和气质，不出现直角卡片

## Components

- **消息气泡**：用户 = 中性淡底 `--user-bubble` + ink 文字（不用 accent 强填充）；agent = 白/抬升卡片
- **审批卡**：accent 描边 + 微 tint 底（浅 `#F2F5F9`），命令行 mono 呈现，批准/拒绝按钮 46px 高
- **代码块**：恒深色卡片，标题栏 + mono 输出，pass/fail 用固定深底配色（`#6CC0A0` / `#E57373`）
- **会话 chips**：pill 形，选中态 accent-dim 底 + accent-strong 文字
- **composer**：胶囊输入框（50px 高）+ accent 圆形发送钮
- **状态栏 theme-color**：落地时 meta 随主题切换（浅 `#FFFFFF` / 深 `#1C1C1E`）

## Do's and Don'ts

**Do**

- 新 UI 元素优先复用上表 token，不引入新色相
- 深色模式跟随浅色映射规则（明度反转 + accent 提亮），不单独配色
- 语义状态必须图标 + 颜色双通道

**Don't**

- 不使用终端 / CRT / 荧光屏隐喻与等宽标题
- 不引入第二个高纯度签名色；橙色只保留给 agent 活动
- 不用渐变按钮 / 渐变 hero / 装饰光斑
- mono 不用于标题和正文

## 实现状态（截至定稿）

以下为设计 vs 实现的差异清单，落地时处理（本文档不随实现同步，实现完成后由对应 PR 更新本节）：

- `site/src/app/globals.css` 仍是旧 token（纯黑 `#000` 底、accent `#4FC3F7`、历史命名 `--green*`）
- accent 及其 rgba 衍生约 42 处硬编码散布于 `globals.css`、`site/src/components/landing/hero.tsx`、`site/src/app/opengraph-image.tsx`
- `site/src/lib/ui/remote-pi-theme.ts` 的 Mantine ramp 仍是旧天蓝，需按本规格重新生成
- 字体仍为 Space Grotesk / Hanken Grotesk / JetBrains Mono，需换 Manrope（+ 衬线品牌层）
- `forceColorScheme="dark"` 需改为双主题（系统跟随 + 手动覆盖）
