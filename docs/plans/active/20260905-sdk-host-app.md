# 基于 Pi SDK 的独立应用：初步构想

> 记录日期：2026-09-05。本文只记录新产品的大致方向，不是完整实施方案，也不代表现有实现或开发排期。
> 当前实现仍以 [ARCHITECTURE.md](../../ARCHITECTURE.md) 为准；既有决策见 [已关闭决策](../../adr/20260518-closed-decisions.md)。本文的新方向不受旧方案兼容要求约束，正式实施前再细化契约与决策记录。

## 1. 已确认方向

- 按照一个基于 Pi SDK 封装的全新软件设计，不再定位为现有 Pi CLI 的远程控制插件。
- PC 端使用 Electron 封装共享 Web UI，也可以通过浏览器或 PWA 使用；移动端使用 PWA。
- 宿主机长期运行 Host Service，由它统一管理并操作 Pi。Electron 与 PWA 是 UI 客户端，不直接持有 Pi runtime。
- 本地与远程操作最终都通过宿主机上的 Pi SDK 执行。Relay 只负责远程通信，不运行 Pi。
- 不保留旧 Remote Pi Extension、Pi RPC、附着现有 TUI、旧协议或旧数据迁移的兼容路径。

## 2. 整体架构

```text
共享 Web UI
  ├─ 本地 Electron → preload / Main → 本机 IPC ─┐
  └─ Electron / 浏览器 / PWA → Relay ────────────┤
                                               ↓
                                         Host Service
                                               ↓
                                      Pi SDK Runtime
                                               ↓
                                模型服务、工具与宿主机文件系统
```

本地 Electron 不经过 Relay。PWA 不能直接运行依赖 Node.js、文件系统和进程能力的 Pi SDK，必须连接 Host Service；首版建议 PWA 统一经 Relay 连接，浏览器直连本机服务的方式另行评估。

## 3. 组件职责

| 组件 | 职责 |
|---|---|
| Web UI | 时间线、编辑器、命令菜单、设置和会话导航；管理草稿、展开状态等界面状态 |
| Electron | 桌面窗口、托盘、本机 Host Service 启动与连接，通过受限 IPC 暴露能力 |
| Host Service | 设备身份、配对授权、工作区与会话管理、runtime 生命周期、业务命令处理和状态同步 |
| Pi SDK Runtime | 使用 `AgentSessionRuntime` 等 SDK 能力执行对话、工具、模型切换及会话操作 |
| Relay | 连接鉴权、在线发现和消息路由，不负责模型调用、工具执行或会话持久化 |

建议每个活动 runtime 使用独立 Node 子进程，由 Host Service 管理。进程隔离用于降低故障影响，不等于安全沙箱。具体进程模型尚待确认。

## 4. 操作与生命周期

- 本地 IPC 与远程 Relay 使用同一套应用命令和事件语义，进入 Host 的同一套业务处理逻辑。
- 以 Pi TUI 的主要操作语义为参考，在 Web 中实现 transcript、thinking、工具结果、队列、编辑器和状态信息，不逐像素复制终端。
- `/` 是统一操作入口：UI 负责菜单与交互，Host 将业务动作映射为 SDK 调用；不把任意 slash 文本作为通用远程执行协议。
- Host 在没有活动 Pi runtime 时仍保持在线，以接收启动请求。机器关机、休眠或 Host 未运行时，Relay 本身不能启动它。
- 建议关闭窗口或客户端断线不终止任务，重连后从 Host 恢复权威状态。
- 建议区分 Host、Workspace、Session 与 Runtime：会话历史独立于进程存在，同一 session 同时只有一个权威写入 runtime。

## 5. 待细化事项

- Host Service 的安装、开机启动、退出策略，以及 SDK 版本固定和升级方式。
- 工作区登记、会话历史、恢复、分支、并发控制和持久化结构。
- 命令与事件协议、请求确认、取消、重连恢复和崩溃后的副作用处理。
- 配对、权限、凭据存储、远程加密与工具执行边界；工作区目录限制不能替代文件系统沙箱。
- Pi skills、自定义工具和插件的加载策略，以及插件 UI 的 Web 表达。不依赖 Remote Pi Extension，不等于排除整个 Pi 插件生态。
- PC 与移动端布局、首版功能范围，以及 PWA 本机直连是否纳入首版。

## 6. 建议推进顺序

1. 完成本地 Electron → Host Service → Pi SDK 的最小操作闭环。
2. 加入 Relay、配对和移动 PWA，验证同一会话的跨端操作与断线恢复。
3. 完善会话管理、命令体系、资源加载和多端交互一致性。

以上仅为建议顺序，不构成实现、迁移或发布授权。
