# 项目路线图

本文是已确定事项的唯一项目级状态来源。状态描述明确的交付范围，不由文件是否位于 `active/`、历史段落或未勾选项推断；未确定开发的候选事项见 [BACKLOG](BACKLOG.md)。

## 尚未结束

| 事项 | 状态 | 当前边界与下一步 |
| --- | --- | --- |
| [PWA 加固与真实设备验收（Plan 64）](plans/active/20260824-pwa-hardening.md) | 进行中 | Serwist、离线壳与多标签控制已有实现；尚缺真实 iOS/Android 关键流程通过证据。保留设备发布门槛，不重做已被取代的 room/旧历史规则。 |
| [素靛双主题](plans/active/20260830-pwa-theme.md) | 待开始 | 原设计记录为已确认，已有[原型](prototypes/20260830-pwa-theme.html)，但当前代码仍采用深色天蓝基线。实施范围和验证须另行授权，本轮仅迁移文档与原型。 |

## 已交付范围

下表沿用相应记录中的完成证据，不代表本轮重新执行了业务测试，也不把记录中的未覆盖风险自动视为完成。

| 事项 | 状态 | 完成依据与剩余边界 |
| --- | --- | --- |
| [框架与组件规范：阶段 A](plans/completed/20260905-framework-component-alignment.md) | 已完成 | 已补齐长期文档、调整协作规范、纠正引用与事项状态；仅完成获准的文档范围。阶段 B/C 未实施，保留为 BACKLOG 候选。 |
| [PWA 消息去重与权威时间线（Plan 63）](plans/completed/20260823-pwa-message-duplication.md) | 已完成 | 计划文首与阶段 5 已记录自动化及真实 Relay/Pi/PWA 联调完成；早期“阶段 1 实现中”保留为过程快照，不再据此标为进行中。 |
| [PWA 图片附件核心能力（Plan 65）](plans/completed/20260827-pwa-image-attachments.md) | 已完成 | 提交 `157dfc8` 与原真实联调记录支撑核心交付；真实移动相机/相册、系统剪贴板权限、透明 PNG 超限和接近 frame 上限的大图传输仍未全部覆盖。 |
| [UI 组件库迁移（Plan 66）](plans/completed/20260828-ui-component-library-migration.md) | 已完成 | 结束证据见 Plan 68；当前组件与视觉规则由 DESIGN 维护，归档计划不再维护现行规范。 |
| [PWA 自动化测试体系（Plan 67）](plans/completed/20260830-pwa-automated-testing.md) | 已完成 | 分层测试基础设施与阶段收口见 Plan 68；当前命令和验证选择由各子项目 AGENTS 维护。 |
| [PWA UI 与测试交付路线（Plan 68）](plans/completed/20260829-pwa-ui-quality-roadmap.md) | 已完成 | 记录了各阶段收口、本机双 Owner 浏览器矩阵与真实模型 timeline 持久化补验；跨物理设备矩阵没有执行。 |
| [移除 Agent Mesh 并重构 Daemon（Plan 69）](plans/completed/20260829-remove-agent-mesh-and-rework-daemon.md) | 已完成 | 后续真实 Relay 与 timeline 验收见 Plan 68，revoke 通知缺口见 Plan 70 的完成记录；不再沿用“真实 Relay 链路全部待验收”的早期摘要。跨物理设备验证仍是未覆盖范围。 |
| [Revoke peer-stop 生命周期缺口（Plan 70）](plans/completed/20260902-revoke-peer-stop-lifecycle-gap.md) | 已完成 | 修复与验收范围以其结束记录为依据。 |
| [Pairing 事务原子性缺口（Plan 71）](plans/completed/20260904-pairing-transaction-atomicity-gap.md) | 已完成 | 完成范围限当前进程内恢复与补偿；不承诺 Pi 进程重启后恢复同一 pairing request。 |

## 被取代的早期方案

以下取消的是旧方案的继续执行，不是取消 PWA 产品。仍有效的产品背景与当前架构已分别进入 [CONTEXT](CONTEXT.md) 和 [ARCHITECTURE](ARCHITECTURE.md)；原文仍可追溯。

| 事项 | 状态 | 结束原因 |
| --- | --- | --- |
| [早期 PWA 范围基线（Plan 61）](plans/completed/20260822-pwa-scope.md) | 已取消 | 原 A2/room 范围已被 Protocol v2、endpoint 模型及后续图片能力取代，不作为当前功能清单；原 checkbox 不补勾。 |
| [早期 PWA 架构草案（Plan 62）](plans/completed/20260822-pwa-architecture.md) | 已取消 | 旧 wire、room、本地数据和手写 Worker 草案不再实施，现行架构由长期文档承接；不把历史草案改写为已完成实现。 |

其他历史方案与参考通过[迁移索引](reference/legacy-plans.md)查找。历史待办不因归档或迁移自动成为当前候选事项；需要继续处理时先核对是否仍有效，再进入对应跟踪入口。
