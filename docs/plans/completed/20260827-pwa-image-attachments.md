> 历史边界：本文件记录已交付的图片附件核心范围及其保留风险，不作为当前执行或项目状态真源；当前协议以 [PROTOCOL](../../reference/protocol/README.md) 为准，未覆盖的移动设备与大图真实传输风险不因归档消失。当前状态见 [ROADMAP](../../ROADMAP.md)。

# Plan 65 — PWA 图片附件

**状态：进行中**

## 目标

为 Remote Pi 的浏览器 PWA 增加图片附件能力，让用户把截图或照片发送给支持视觉输入的 Pi Agent 进行分析。图片作为多模态消息内容进入模型，不作为项目文件上传或长期落盘。

## 已确认范围

- 入口：系统文件选择器、剪贴板图片、系统/浏览器相机入口。
- 相机使用 `<input type="file" accept="image/*" capture="environment">`，不实现页面内置取景器。
- 相机不可用或权限被拒绝时，显示明确错误并保留文件选择入口；不清空文字草稿或已有附件。
- UI 第一版每条消息限制一张图片；协议继续使用可扩展的 `images[]`。
- 允许纯图片消息，文字说明可选。
- Agent 忙时图片进入 Pi 队列，PWA 显示带缩略图的排队气泡，并向其他 Owner 广播完整图片和文字。
- 排队消息可以取消；替换图片通过取消后重新选择完成，不增加直接替换语义。
- 图片队列容量：每个 Owner 总计 `8 MiB`，所有 Owner 总计 `32 MiB`。超过上限只拒绝新的图片队列项，已有文字队列不受影响。
- 离线时完全禁用图片选择、粘贴和拍照，不创建本地待发送附件。
- 发送失败、超时或 `unknown_delivery` 时保留当前会话内的附件，由用户手动重试；不自动重发。
- 重试复用原 `client_request_id`，依靠现有幂等状态避免重复调用模型；相同请求 ID 搭配不同内容必须判定为冲突。
- 当前模型不支持视觉输入、模型能力未知或连接不可用时，图片按钮保留但置灰并说明原因。
- 剪贴板同时包含文字和图片时只提取图片，不修改当前文字草稿；纯文本粘贴保持原行为。
- 历史图片继续通过现有 session sync、timeline 和 IndexedDB 路径恢复；第一版继续用 base64 data URL 渲染。

## 图片处理

- 所有图片都重新解码并重新编码，不直接发送原文件；重新编码顺带清除 EXIF。
- PNG 输入重新编码为 PNG；JPEG/WebP 输入重新编码为 JPEG。
- 透明 PNG 默认保留透明度；在尺寸压缩后仍无法满足限制时拒绝发送，不自动铺背景或静默转 JPEG。
- JPEG/WebP 以约 `2048px` 长边、质量约 `85` 为起点，逐步降低尺寸和质量；最低长边 `768px`、最低质量 `50`。
- 图片不能压缩到不可分析的程度；达到下限仍超限时保留附件并提示失败。
- 压缩预算按完整消息动态计算：先扣除文字、ID、频道和 JSON 封装，图片使用剩余预算；不静默截断文字或图片。

## 协议与传输

- Protocol v2 的全局 inner frame 上限从 `512 KiB` 提高到 `2 MiB`。
- Relay 外层 `ct` 默认上限保持 `4 MiB`，不新增 Relay API、二进制通道或图片分片协议。
- PWA 和 Pi Extension 配套直接升级，不做旧版本兼容或能力协商。
- 发送前同时执行 inner frame 和 Relay 外层大小预算预检。
- 图片仍以内联 base64 方式进入 `user_message.images`，接受双重 base64 的体积开销。
- 队列状态协议需要携带图片，使多 Owner、重连和取消状态一致；现有仅文本队列语义需要相应扩展。
- 应核对 timeline event、history chunk 和 fragment 的既有限制，避免为图片扩大无关协议窗口。

## 实现拆分

### PWA 图片处理

新增图片处理模块，负责：

- 文件、剪贴板和相机输入统一转换为图片附件；
- MIME 和文件大小校验；拒绝 SVG 等不需要的格式；
- `createImageBitmap`/Canvas 解码、方向处理、缩放、重新编码和 base64 转换；
- EXIF 清除；
- 动态帧预算、压缩重试和失败原因返回；
- 释放 `ObjectURL`，避免重复选图造成内存泄漏。

### Composer 与状态

修改 PWA Composer：

- 增加图片附件按钮和系统文件/相机入口；
- 增加剪贴板图片粘贴处理；
- 显示缩略图、大小、处理中状态和删除按钮；
- 有文字或图片时启用发送；
- 图片发送时调用 `TimelineRuntime.sendUser(text, images)`；
- Agent 忙时支持带图片的 pending/queued 状态、取消和手动重试；
- 离线、未知能力、text-only 模型和超容量状态正确置灰。

### 模型能力

复用 `WireModel.vision`：

- 连接建立和模型切换后获取当前模型能力；
- `vision: true` 才允许图片发送；
- `vision: false`、能力未知或连接非在线时保留置灰按钮；
- 服务端能力拒绝时保留附件和草稿并显示可理解的错误。

### 历史与渲染

- pending、queued、echo、timeline event 和历史恢复都保留图片字段；
- 图片气泡显示缩略图和可选说明；
- 第一版沿用 base64 data URL，不实现全屏预览、缩放或下载；
- 验证大图经过实时广播、重连、分页历史和 IndexedDB 恢复后仍能显示。

## 非目标

- 不上传到项目目录，不新增远程文件存储。
- 不支持通用文件、PDF、视频或音频文件。
- 不支持多图交互（协议保持可扩展）。
- 不实现内置相机取景器、拖拽增强、全屏图片查看或图片编辑。
- 不实现二进制 Relay 通道、文件分片或 out-of-band 上传。
- 不为旧版 PWA/Extension 增加兼容降级或能力协商。
- 第一版不显示图片隐私确认提示；待未来重新启用 E2E 后统一设计隐私告知。

## 验证清单

- 单元测试覆盖 JPEG、PNG、WebP、透明 PNG、EXIF 清除、缩放、质量下限、动态帧预算和超限失败。
- Composer 测试覆盖文件选择、剪贴板图片、系统相机入口、预览、删除、纯图片发送和失败重试。
- 队列测试覆盖图片广播、`8 MiB/Owner`、`32 MiB` 全局限制、取消、超时和幂等重试。
- 模型能力测试覆盖 `vision=true/false/unknown` 的置灰和恢复。
- 协议测试覆盖 `2 MiB` inner frame、新旧内容冲突、图片 echo、历史同步和 fragment 路径。
- 浏览器 smoke 覆盖桌面文件选择、桌面剪贴板截图、移动端相机、移动端相册、断线、text-only 模型和透明 PNG 超限。
- 执行 `cd site && pnpm lint`、`cd site && pnpm build`、受影响测试以及 `git diff --check`。

### 真实联调记录（2026-08-27）

已使用隔离的本地 Relay、临时 Pi 身份、当前源码 Extension 和两个独立浏览器 profile 验证：

- 两个 Owner 均完成真实配对并同时保持 `LIVE`；视觉模型入口在 v2 `models_list.current.vision=true` 后启用。
- 文件选择、浏览器原生剪贴板 `paste` 事件和 `capture="environment"` 相机 input 已验证；剪贴板图片不覆盖草稿。
- 带文字图片和纯图片均经 PWA → Relay → Extension → Pi 视觉模型成功识别。
- busy 期间图片显示 `Queued / accepted`，发起 Owner 可取消；另一 Owner 可见同一图片队列但没有取消权限。
- 取消后两个 Owner 的队列气泡同时消失，图片未进入模型；busy 结束后的未取消图片可正常 drain。
- Relay 断线时附件和草稿保留、入口禁用；恢复 `LIVE` 后附件仍在且可手动发送。
- 当前 Extension 全量测试为 `857 passed / 3 skipped`，Site 相关测试 `17 passed`，两端 typecheck/build 和 `git diff --check` 通过；改动 Site 文件定向 lint 为 0 error、3 个 data URL `<img>` warning。

尚未覆盖：真实移动设备相机/相册、浏览器系统剪贴板权限弹窗、透明 PNG 超限和接近 `2 MiB` 的真实大图浏览器传输。

## 已知风险

- 双重 base64 会扩大传输体积；`2 MiB` inner frame 接近 Relay `4 MiB` 外层预算时必须保守预检。
- 图片进入广播、历史同步和浏览器内存，队列总量和单帧预算必须同时限制。
- 当前 MVP 无 E2E，Relay 运营者理论上可见消息和图片内容；本计划不新增提示，后续 E2E 任务统一处理。
