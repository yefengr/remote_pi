# 计划 64 — PWA 规范化与 Serwist 加固

状态：已确认

基于：`plan/61-pwa-scope.md`、`plan/62-pwa-architecture.md`

本文件记录 Remote Pi PWA 规范化与 Service Worker 加固的确认结果。它补充并在 PWA Service Worker 方案上取代 `plan/62-pwa-architecture.md` 中的“小型自定义 Service Worker”方案；不修改 Relay、`pi-extension` 或消息历史同步协议。

## 1. 目标与定位

Remote Pi PWA 是一个可安装的在线远程控制应用，提供离线启动和本地历史查看能力，但不承诺离线控制 Agent。

离线能力的正式语义：

- 可以打开 `/app`。
- 可以查看当前浏览器中的本地身份、配对信息和消息历史。
- 不建立 Pi / Relay 实时连接。
- 不获取新的 Agent 输出。
- 不允许发送消息。
- 不建立离线发送队列。
- 网络恢复、页面回到前台或用户重新打开应用时，按需恢复连接。

消息历史的全量同步、分页、断点续传和协议关联问题不属于本次 PWA 加固范围，继续使用当前已有同步机制，由后续独立计划处理。

## 2. 技术决策

| 领域 | 决策 |
|---|---|
| 应用框架 | 保留 Next.js 16、React 19、TypeScript，不迁移到 Vite |
| PWA 工具 | 引入 `@serwist/next` 与 `serwist` |
| Service Worker | 由 Serwist 在生产构建阶段生成 `public/sw.js`，替换现有手写版本 |
| PWA scope | 只控制 `/app`，不控制官网、Docs 和 Tutorials |
| 应用数据 | 继续由页面通过 Dexie 使用 IndexedDB |
| 实时通信 | 继续使用页面内 Relay WebSocket |
| 推送 | MVP 不做 Web Push、Background Sync 或后台 Agent 通知 |
| 部署 | 保留 Next.js Standalone Docker 输出 |
| 开发环境 | 开发环境不注册持久 Service Worker，并清理历史开发缓存 |

`vite-plugin-pwa` 不纳入本项目，因为当前站点不是 Vite 项目。

## 3. Service Worker 与缓存边界

### 3.1 允许缓存的内容

Service Worker / Cache Storage 只保存应用资源：

- `/app` 页面或离线应用壳；
- Next.js 构建生成的 `/_next/static/*`；
- CSS、字体和图标；
- `manifest.webmanifest`；
- PWA 启动所需的其他静态资源。

Serwist 负责构建阶段的预缓存清单、资源版本、旧缓存清理和 Service Worker 生命周期。

### 3.2 禁止缓存的内容

以下内容必须保持 Network Only，不进入 Cache Storage：

- Relay WebSocket 帧；
- Relay HTTP 请求和响应；
- 未来新增的动态 API；
- Next.js RSC / Flight 动态请求；
- 配对 QR 内容和连接状态；
- 用户消息、Agent 输出和会话数据。

消息历史只保存在 IndexedDB，不在 Cache Storage 中复制一份。

### 3.3 页面策略

`/app` 采用 Network First：

```text
访问 /app
  -> 优先请求当前线上版本
  -> 请求成功：返回线上版本并更新缓存
  -> 请求失败：回退到最近一次成功缓存的 /app
```

静态构建资源使用预缓存或 Cache First。线上部署时应保证 `/app` 不长期停留在旧页面，但完全断网时仍可以使用缓存启动。

### 3.4 Service Worker 响应头

`/sw.js` 必须允许重新验证，不得使用长期 `immutable` 缓存：

```http
Cache-Control: no-cache
Content-Type: application/javascript
```

`/_next/static/*` 可以使用带 hash 的长期缓存。Manifest 使用短缓存或重新验证策略。

## 4. 更新、安装与安全上下文

### 4.1 更新行为

- 新版 Service Worker 可以后台安装。
- 不强制刷新当前页面。
- 当前流式输出、未提交草稿和页面状态不得因 Worker 更新被主动中断。
- 检测到新版后显示非阻塞的应用内更新提示。
- 用户主动刷新后完成版本切换。
- 顶部已有的刷新操作可以作为主动刷新入口。

### 4.2 安装入口

- 根据浏览器能力条件式显示 `Install app`。
- 浏览器不支持安装提示时不显示无效按钮。
- iOS 使用系统“添加到主屏幕”流程，不把自定义安装 API 作为前提。
- 用户不安装 PWA 时，普通浏览器访问仍然可用。

### 4.3 HTTPS

正式环境只支持 HTTPS；开发环境允许 `localhost` 和 `127.0.0.1`。

不支持通过普通局域网 HTTP 运行，因为 Web Crypto、摄像头、Service Worker 和安全 WebSocket 依赖安全上下文。不得为局域网 HTTP 增加绕过检查的降级模式。

### 4.4 Service Worker 不可用

如果浏览器支持 IndexedDB、Web Crypto 和 WebSocket，但不支持或禁用了 Service Worker：

- 应用继续作为普通在线网页运行；
- 可以使用在线 Relay 连接和本地 IndexedDB；
- 不承诺 PWA 安装和离线冷启动；
- 界面应明确提示当前浏览器不具备完整 PWA 离线能力。

IndexedDB 不可用时则拒绝启动，不生成临时身份，不进入临时在线模式。

## 5. 本地数据与生命周期

### 5.1 IndexedDB 数据

IndexedDB 是浏览器业务数据的唯一存储，保存：

- Owner identity；
- `peerEpk + roomId` 配对；
- room 元数据；
- 消息历史；
- Relay 和界面设置；
- 最后同步时间等本地状态。

消息历史视为用户数据：MVP 不按时间、数量或大小自动清理，不提供导出、恢复、云端备份或跨设备同步。用户可以在 Settings 中主动清除本地数据。

浏览器清除站点数据、更换浏览器或更换设备后，身份、配对和本地历史可能丢失；产品应明确提示这一风险。

### 5.2 配对删除

删除配对按精确的 `peerEpk + roomId` 范围处理：

- 删除该 pairing；
- 删除对应 room 记录；
- 删除该 room 的消息历史；
- 保留同一个 Pi 其他 room 的配对和历史；
- 不影响其他 Pi。

`Clear local data` 仍然是全局破坏性操作，删除全部身份、配对、room、消息和设置，并要求二次确认。

### 5.3 历史新鲜度

离线或连接失败时显示 `Local history` 和最后同步时间。`lastSyncedAt` 只有在历史同步真正完成后才更新：

- WebSocket 鉴权成功不等于历史同步成功；
- 收到并处理完历史响应后才更新；
- 空历史也必须收到明确的同步完成结果后更新；
- 连接失败时保留上一次成功同步时间；
- 实时消息可以更新最近活动时间，但不能替代历史同步时间。

本次不修改当前消息历史同步上限、分页或协议关联逻辑。

### 5.4 Room 在线状态

没有当前有效 Relay 连接时，room 不得显示为 `online`：

- 可以显示 `offline` 或 `last known`；
- 可以保留名称、cwd、模型等最后已知元数据；
- 只有收到本次连接的 room 快照或实时 room 事件后，才能显示为在线。

### 5.5 中断的流式输出

流式 Agent 输出在连接中途断开时：

- 保留已经收到的文本；
- 在本地标记为 `interrupted`；
- 不标记为 `complete`；
- 不因为刷新而把已展示的部分输出静默丢失。

这项语义只处理 PWA 本地消息状态，不改变历史同步协议。

## 6. 多标签页连接控制

同一浏览器同一时间只允许一个 `/app` 页面持有 Relay 活动连接：

- 活动页建立 WebSocket 并允许发送；
- 其他标签页可以打开并读取本地历史；
- 其他标签页不建立 WebSocket，不允许发送；
- 活动页关闭、崩溃或释放锁后，其他页面自动接管连接；
- 接管不需要重新配对或手动刷新。

实现可使用 Web Locks API 或 BroadcastChannel；锁机制必须覆盖浏览器标签页和已安装 PWA 窗口能够共享的同源上下文。

## 7. Manifest 与图标规范

- `start_url` 为 `/app`；
- `scope` 为 `/app`；
- `display` 使用 `standalone`；
- 保留 192x192 与 512x512 图标；
- 普通图标和 maskable 图标分开声明；
- maskable 图标为系统裁剪预留安全区域；
- 图标和 Manifest 不携带用户数据、配对信息或密钥。

自动检查文件格式、尺寸、Manifest 引用、`purpose` 和 HTTP MIME 类型；真实设备检查 Android 启动器裁剪、iOS 主屏幕图标和 standalone 启动效果。

## 8. 浏览器支持与验收分工

### 8.1 正式验收范围

- Chrome / Edge 桌面端；
- Chrome Android；
- 最近两个版本的 iOS Safari。

iOS Chrome 至少做功能兼容 smoke test；如果产品将 iOS Chrome 的“添加到主屏幕并以应用方式启动”作为正式支持路径，再额外提升为发布阻断条件。Safari 是 iOS PWA 安装和 standalone 行为的基准。

### 8.2 自动化验收

主 Agent 可以自动完成：

- `pnpm install --frozen-lockfile`；
- `pnpm lint`；
- `pnpm build`；
- TypeScript 和 Serwist 构建集成检查；
- Standalone Docker 产物检查；
- `/app`、`/sw.js`、Manifest、图标和静态资源可访问性；
- Manifest 字段、图标尺寸、格式和 MIME 类型；
- Service Worker 注册、`/app` scope、缓存内容、动态请求不缓存、版本更新和旧缓存清理；
- Chromium 中的 IndexedDB、本地历史、断网冷启动、Room 离线状态和更新提示；
- 有稳定测试 Relay / Pi 时，进一步自动验证配对、WebSocket、重连和在线发送；
- `git diff --check`。

### 8.3 真实设备验收

必须由真实设备完成：

- iOS Safari 添加到主屏幕和 standalone 启动；
- iOS Safari 断网冷启动、IndexedDB 历史读取和恢复联网；
- iOS Chrome 访问、Service Worker、IndexedDB、扫码和添加到主屏幕行为；
- Android Chrome 安装、maskable 图标裁剪、断网冷启动和恢复联网；
- 摄像头权限、QR 扫描、移动键盘、安全区、切后台和系统挂起恢复。

最终发布门槛为：自动化验收通过，加上至少一台真实 iOS 设备和一台真实 Android 设备的关键流程通过。没有真实设备时，只能标记为“自动化与 Chromium 验证通过，移动端未验证”。

## 9. 本次明确不做

- 消息历史全量同步、分页、断点续传和跨端关联修复；
- Relay 或 `pi-extension` 协议修改；
- 账号、云端 Vault、跨设备恢复和导出文件；
- Web Push、Background Sync、后台 WebSocket 保活；
- 离线消息队列；
- 普通网站和文档页面的离线缓存；
- 为不安全 HTTP 增加绕过模式；
- 为了 PWA 迁移到 Vite；
- 自动提交、推送、发布或部署。

## 10. 后续实施顺序

1. 添加 `@serwist/next` 与 `serwist`，更新 pnpm lockfile。
2. 用 `withSerwist` 包裹现有 Next 配置，保留 Standalone 和开发来源配置。
3. 创建 Serwist Service Worker 源文件，配置 `/app` scope、静态预缓存、Network First 页面和动态请求排除。
4. 调整 TypeScript、`.gitignore` 和现有 Service Worker 注册逻辑。
5. 规范 Manifest 和普通/maskable 图标。
6. 实现更新提示、安装入口、最后同步时间、room 在线状态和中断流式消息状态。
7. 实现同源多标签页 Relay 锁和自动接管。
8. 实现配对删除时按 `peerEpk + roomId` 清理本地 room 与消息。
9. 完成自动化与真实设备验收；消息历史同步保持独立计划。
