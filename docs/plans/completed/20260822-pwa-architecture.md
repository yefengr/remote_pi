> 历史边界：本文件是被取代的旧 PWA 架构快照，不作为当前执行或项目状态真源；当前架构以 [ARCHITECTURE](../../ARCHITECTURE.md) 与 [PROTOCOL](../../../PROTOCOL.md) 为准。当前状态见 [ROADMAP](../../ROADMAP.md)。

# Remote Pi PWA 技术架构方案

状态：草案，基于 `docs/plans/completed/20260822-pwa-scope.md`（2026-08-22）

## 1. 目标

在现有 `site/` Next.js 项目内实现 Remote Pi PWA，使用浏览器直接连接 Relay，复用现有 QR 配对、Ed25519 challenge-response、Peer/Room 路由和 Client/Server message wire protocol。

本方案只覆盖 A2 首版范围：本地浏览器身份、Pi / Room 配对、单当前 Pi / Room 实时连接、文本聊天、流式输出、Room 切换、本地历史和 O1 离线只读。账号服务、云端 Vault、聊天历史同步、Push、图片和语音不进入本方案。

## 2. 技术基线

| 领域 | 方案 |
|---|---|
| 应用框架 | 现有 Next.js 16 + React 19 + TypeScript |
| PWA 路由 | `/app`，作为独立客户端页面运行 |
| 运行方式 | 浏览器客户端直连 Relay，不新增 Next.js 服务端代理 |
| 实时传输 | 浏览器原生 `WebSocket` |
| 身份密码学 | `@noble/ed25519`，生成 Owner keypair 并签署 Relay challenge |
| 本地数据库 | IndexedDB，通过 `Dexie` 管理 schema、索引和迁移 |
| QR 扫描 | `@zxing/browser`，摄像头扫描 + 图片文件 fallback |
| Markdown | `react-markdown` + `remark-gfm` |
| 代码块 | Markdown 自定义 renderer；优先复用站点 CSS，语法高亮使用成熟库 |
| UI 图标 | `lucide-react`，遵循现有站点视觉规范 |
| 状态管理 | React Context、`useReducer` 和 feature hooks，不引入大型全局状态库 |
| PWA | `manifest.webmanifest` + 小型自定义 Service Worker |
| 测试 | TypeScript 单测、协议 fixture 测试、IndexedDB 测试、Playwright 浏览器 smoke |

依赖安装前检查 `site/package.json` 和锁文件，优先选择项目已有依赖；新依赖必须在实现计划和变更说明中列出用途、版本和浏览器兼容边界。

## 3. 目录结构

建议新增以下结构：

```text
site/
  public/
    app-icon-*.png
    manifest.webmanifest
    sw.js
  src/
    app/
      app/
        layout.tsx
        page.tsx
      app-shell.tsx
    components/
      pwa/
        app-shell.tsx
        connection-status.tsx
        offline-banner.tsx
        pair-flow.tsx
        qr-scanner.tsx
        peer-list.tsx
        peer-card.tsx
        room-picker.tsx
        chat-view.tsx
        message-list.tsx
        message-bubble.tsx
        message-composer.tsx
        settings-panel.tsx
    lib/
      remote-pi/
        crypto.ts
        encoding.ts
        protocol.ts
        relay-client.ts
        peer-channel.ts
        pairing.ts
        connection-manager.ts
        room-router.ts
        session-sync.ts
        types.ts
      pwa/
        db.ts
        db-schema.ts
        repositories.ts
        service-worker.ts
        lifecycle.ts
```

实际拆分可以随实现调整，但协议、传输、本地存储和 UI 不应混在同一模块。PWA 页面不得直接操作 IndexedDB 或 WebSocket，应通过 `remote-pi` / `pwa` 适配层访问。

## 4. 数据与身份模型

### 4.1 Owner identity

- 首次启动时在浏览器生成 Ed25519 keypair。
- 生成逻辑使用 `crypto.getRandomValues` 和 `@noble/ed25519`。
- 私钥只存当前浏览器的 IndexedDB，并只在内存中用于签名。
- 不上传 Owner private key，不调用账号服务，不做导出/恢复。
- 数据库不存在 keypair 时才生成；不能因页面刷新或连接失败重新生成。
- 生成后校验 public key 与 private seed 可重新构造并签名验证。

### 4.2 配对记录

IndexedDB 至少保存：

```text
PairingRecord
- id = (remoteEpk, roomId) 的稳定本地键
- remoteEpk
- sessionName
- relayUrl
- pairedAt
- nickname?
- roomId
- harness?
```

沿用 Flutter App 的字段语义和 base64 编码兼容规则。QR 解析沿用：

```text
remotepi://pair?t=<token>&epk=<peer-public-key>&n=<name>[&r=<relay>][&rm=<room>]
```

PWA 发送的 `pair_request` 必须与现有协议字段兼容，并在收到 `pair_ok` 后持久化 Pi 确认的 `room_id`。

### 4.3 聊天历史

按 `(remoteEpk, roomId)` 分区保存本地消息。至少支持：

- 用户消息
- `agent_chunk` 聚合后的 assistant 消息
- `agent_done` 完成状态
- `agent_message` / `session_history` 恢复消息
- 错误和取消状态
- 时间戳、消息 id、`in_reply_to`

流式 chunk 先进入内存 reducer；完成或达到节流窗口后写入 IndexedDB，禁止每个 chunk 单独触发数据库写入。

## 5. Relay 与协议适配

### 5.1 浏览器 RelayClient

使用原生 WebSocket 实现：

1. 将用户配置的 `http(s)` Relay 地址转换为 `ws(s)`。
2. 建立 WebSocket。
3. 发送 `hello`：Owner public key、`room_id: main`。
4. 接收 `challenge`。
5. 使用 Owner private key 签署 nonce，发送 `auth`。
6. 认证成功后处理 envelope 和 control frames。
7. 按现有 `peer`、`room`、`ct` 外层格式发送和接收。
8. 处理 close/error/visibility 事件，交给 ConnectionManager 重连。

浏览器端不实现 Node `ws` API，不依赖 `IOWebSocketChannel`，也不修改 Relay auth contract。

### 5.2 PeerChannel

将 `ct` base64 解码为 UTF-8 JSON，并映射到 TypeScript discriminated union：

```text
agent_chunk
agent_done
tool_request
tool_result
error
cancelled
pong
pair_ok
pair_error
user_input / user_message
agent_message
compaction
session_history
bye
action_ok / action_error
models_list
```

未知消息类型采用 forward-compatible 策略：记录诊断信息并丢弃，不关闭连接；malformed frame 不能导致整个页面崩溃。

### 5.3 ConnectionManager

- 同一时间只维护一个 active Pi / Room 配对的实时连接。
- 状态至少包含 `noPeer`、`connecting`、`online`、`retrying`、`offline`。
- 重连使用 1、2、5、10、30 秒 backoff，上限固定。
- 页面从后台回到前台时取消旧连接并尝试一次重新连接。
- 网络离线时停止连接尝试，恢复 online 事件后重新开始。
- 切换 Pi / Room 配对时先关闭旧连接，再建立新连接。
- 切换 Room 不关闭 WebSocket，只更新后续 envelope 的 `room` 字段。
- 连接未达到 `online` 时，发送操作必须被阻止。

## 6. 流式消息与渲染

### 6.1 流式处理

```text
agent_chunk(in_reply_to, delta)
  ↓
按 in_reply_to 累积 assistant 文本
  ↓
React reducer 更新当前消息
  ↓
短 debounce / requestAnimationFrame 合并高频渲染
  ↓
agent_done
  ↓
标记完成并持久化
```

- 不手写 Markdown 解析器。
- 使用 `react-markdown` + `remark-gfm`。
- 代码块使用自定义 renderer，避免不可信 HTML 注入。
- 默认不启用 `rehype-raw`。
- 链接使用安全属性；外部链接 `target="_blank"` 时设置 `rel="noreferrer noopener"`。
- 流式期间 Markdown 允许暂时不完整；`agent_done` 后进行最终渲染。
- Agent 输出、代码和命令只渲染本地消息，不上传任何服务端。

### 6.2 断线恢复

连接重新建立后，使用现有 `session_sync` / `session_history` 获取 Pi 侧历史，按消息 id 或 `in_reply_to` 去重并合并到本地 IndexedDB。不能依赖页面内存恢复断线前的 chunk，也不能重复插入历史消息。

Room 切换时必须按 `(remoteEpk, roomId)` 隔离接收和写入，不能让旧 Room 的流式输出混入当前聊天。

## 7. QR 与配对

- 摄像头扫描需要用户主动授权。
- 提供“从图片选择 QR” fallback。
- 扫描结果先严格解析 scheme、host、token、epk、name 和可选 room。
- Relay mismatch 时显示明确提示，不静默切换用户配置。
- 配对过程显示等待、成功、token 过期、token 已消费、Relay 不匹配和未知错误。
- `pair_ok` 成功后保存 PairingRecord；同一 Pi 的不同 `roomId` 使用不同本地记录并加入配对列表。
- 用户可以取消未完成的配对；取消后关闭临时 WebSocket。

## 8. IndexedDB 与生命周期

建议使用 Dexie schema version：

```text
identity
peers
settings
rooms
messages
session_meta
```

要求：

- 数据库初始化和迁移失败时显示可操作错误，不静默清空数据。
- 删除站点数据必须是显式设置操作，并二次确认。
- `visibilitychange`、`online`、`offline`、`pageshow`、`pagehide` 统一接入 lifecycle adapter。
- 页面隐藏时不保证实时连接；可主动关闭或保留连接，但不得宣称后台可靠。
- 页面恢复前台时重新检查网络、连接状态和 active Room。
- Service Worker 不读取 IndexedDB 中的 Owner private key，不参与 Relay 认证。

## 9. PWA 与 Service Worker

自定义 Service Worker 只负责 O1 所需的资源缓存：

- 缓存 PWA shell、manifest、图标和静态 chunk。
- 离线时允许打开 `/app` 外壳。
- 不缓存 Relay WebSocket 帧。
- 不处理 Push、Background Sync 或离线发送队列。
- 不缓存聊天内容到 Cache Storage；聊天历史只由页面 IndexedDB 读取。
- 新版本使用 cache version 淘汰旧静态资源，失败时保留旧 shell。

PWA 必须在 HTTPS 部署；localhost 仅用于开发 smoke。manifest 的 `scope` 和 `start_url` 限制在 `/app`，不影响站点 Docs、Download 和 Tutorials。

## 10. UI 与交互边界

- 首屏直接进入 PWA 工作区，不做营销 Hero。
- 移动端默认单栏；宽屏可使用 Peer 列表 + Chat detail 双栏。
- 连接状态始终可见，但不使用大面积装饰性状态卡。
- 离线时显示只读 banner，发送控件和在线 Room 操作禁用。
- Peer 列表支持在线、重连、离线和未配对空状态。
- 设置中提供 Relay 地址、主题、显示偏好和清理本地数据。
- 图标按钮使用 `lucide-react`，不以文字圆角按钮替代熟悉的图标操作；不熟悉的图标提供 tooltip 或 accessible label。
- 所有动态文本、按钮和消息气泡必须在移动和桌面宽度下不溢出、不重叠。

## 11. 测试与验收

### 11.1 单元测试

- base64 / URL-safe base64 编解码。
- QR payload 解析和非法输入拒绝。
- Ed25519 keypair 生成、challenge 签名和验证。
- Relay URL `http(s)` 到 `ws(s)` 转换。
- 外层 envelope 编解码。
- Client/Server message discriminated union 解码。
- reducer 对 chunk、done、error、history 去重和 Room 隔离。
- ConnectionManager backoff、取消旧连接和前台恢复。
- Dexie repository 的增删改查、迁移和数据清理。

### 11.2 浏览器 smoke

- 首次打开生成 identity，刷新后 identity fingerprint 不变。
- 扫描或上传 QR 后完成 pair_request / pair_ok。
- Relay 断开时显示 retrying/offline，恢复网络后重新 online。
- 文本发送、流式 chunk、agent_done 和本地历史持久化。
- 页面刷新后通过 session_sync/session_history 恢复历史且不重复。
- Room 切换后旧 Room 消息不进入当前 Room。
- 离线时历史可读、发送被禁用、无离线队列。
- 清理站点数据后 identity 和配对列表消失，下一次启动生成新 identity。
- 移动视口和宽桌面视口无明显重叠或横向溢出。

### 11.3 回归验证

- `site` lint、TypeScript、build 通过。
- PWA 新依赖的 lockfile 与许可证状态可审查。
- `relay` 和 `pi-extension` 现有测试不因 PWA 改动失败。
- 最终执行 `git diff --check` 和仓库范围残留搜索。

## 12. 实施顺序

1. 盘点现有 Flutter protocol 和 site 设计 token，冻结 TypeScript wire types。
2. 添加浏览器依赖和 PWA `/app` 路由、manifest、Service Worker 外壳。
3. 实现 IndexedDB schema、Owner identity 和 settings/peer repositories。
4. 实现 Ed25519、RelayClient、PeerChannel 和 envelope 编解码。
5. 实现 ConnectionManager、Room router 和生命周期重连。
6. 实现 QR 摄像头/文件配对流程。
7. 实现 Peer 列表、Chat、流式 reducer、Markdown 和本地历史。
8. 实现离线只读、清理数据、主题和显示设置。
9. 补齐单元测试和浏览器 smoke，执行站点构建及回归验证。
10. 根据验收结果单独更新长期设计文档或创建后续实现计划；不在本方案中扩大首版范围。

## 13. 非目标

- 不创建账号服务或登录页。
- 不实现云端 Vault、同步、恢复码或跨浏览器迁移。
- 不把 Owner private key 放进 URL、QR、日志、Service Worker 或 Cache Storage。
- 不修改 Relay 或 `pi-extension` 的 wire protocol 以适配 UI。
- 不实现后台 WebSocket 保活、Push、Background Sync 或离线发送。
- 不迁移 Flutter App 的原生插件实现到浏览器；只复用协议语义。
