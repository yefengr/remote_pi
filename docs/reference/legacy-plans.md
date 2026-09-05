# 历史文档索引

按原计划编号或完整旧路径查找迁移后的文档。此页只维护路径与历史来源，不维护当前事项状态；当前进度见 [ROADMAP](../ROADMAP.md)，现行协议见 [PROTOCOL](../../PROTOCOL.md)，部署见 [DEPLOYMENT](../DEPLOYMENT.md)。

## 如何阅读归档

- `docs/plans/completed/` 接收已完成、取消、被取代或退出当前执行入口的方案。归档不代表每个历史勾选项已实现，也不重新授权执行旧命令。
- `docs/reference/history/` 保存旧协议、Agent Network 技能样本和 Android 已实现行为快照。这些是历史参考，不是当前协议或可加载技能；Agent Mesh 的取消与 daemon 边界替换见 [Plan 69](../plans/completed/20260829-remove-agent-mesh-and-rework-daemon.md)。
- 原文中的状态、测试数字、提交、未勾选事项、源代码路径和 fenced 代码示例保留为当时快照。示例内路径、仅讨论而未落地的计划名及 `file://` 外部路径不承诺可用；不会为消除历史引用而补造文档或把旧待办自动加入路线图。
- `plan/25` 等编号短引用仍可按下表查找。`plan/` 仅保留导航页，旧单文件 URL 不提供自动重定向；追溯文件沿革时使用 `git log --follow -- <新路径>`。

## 历史方案与参考迁移

下表文件名日期统一采用迁移时 `git log --follow --diff-filter=A --format='%as %H' -- <旧路径>` 可追溯的首次引入提交日期。它不是对实际撰写日、文中决策日或完成日的推断；原文日期不改。提交列保留日期依据，原编号保留在原标题和本索引中。

| 旧路径 | 新位置 | 日期依据提交 |
| --- | --- | --- |
| `plan/01-bootstrap.md` | [`docs/plans/completed/20260517-bootstrap.md`](../plans/completed/20260517-bootstrap.md) | `45469050bbd7` |
| `plan/02-ai-orchestration.md` | [`docs/plans/completed/20260517-ai-orchestration.md`](../plans/completed/20260517-ai-orchestration.md) | `c00e57859a00` |
| `plan/03-protocol.md` | [`docs/reference/history/20260518-protocol.md`](history/20260518-protocol.md) | `24c3a6ff6835` |
| `plan/04-pairing.md` | [`docs/plans/completed/20260519-pairing.md`](../plans/completed/20260519-pairing.md) | `3587db4cb7b9` |
| `plan/05-mvp-features.md` | [`docs/plans/completed/20260519-mvp-features.md`](../plans/completed/20260519-mvp-features.md) | `3587db4cb7b9` |
| `plan/06-rollback-e2e.md` | [`docs/plans/completed/20260519-rollback-e2e.md`](../plans/completed/20260519-rollback-e2e.md) | `3587db4cb7b9` |
| `plan/07-revoke-and-multi-session.md` | [`docs/plans/completed/20260606-revoke-and-multi-session.md`](../plans/completed/20260606-revoke-and-multi-session.md) | `86ec8ec312cc` |
| `plan/08-revoke-multi-pairing.md` | [`docs/plans/completed/20260521-revoke-multi-pairing.md`](../plans/completed/20260521-revoke-multi-pairing.md) | `af8548a726e2` |
| `plan/10-polish-and-bugs.md` | [`docs/plans/completed/20260521-polish-and-bugs.md`](../plans/completed/20260521-polish-and-bugs.md) | `af8548a726e2` |
| `plan/11-session-sync.md` | [`docs/plans/completed/20260521-session-sync.md`](../plans/completed/20260521-session-sync.md) | `af8548a726e2` |
| `plan/12-presence-and-boot-conn.md` | [`docs/plans/completed/20260521-presence-and-boot-conn.md`](../plans/completed/20260521-presence-and-boot-conn.md) | `af8548a726e2` |
| `plan/13-chat-state-recovery.md` | [`docs/plans/completed/20260521-chat-state-recovery.md`](../plans/completed/20260521-chat-state-recovery.md) | `af8548a726e2` |
| `plan/14-onboarding-and-relay-config.md` | [`docs/plans/completed/20260521-onboarding-and-relay-config.md`](../plans/completed/20260521-onboarding-and-relay-config.md) | `af8548a726e2` |
| `plan/15-one-mac-many-sessions.md` | [`docs/plans/completed/20260606-one-mac-many-sessions.md`](../plans/completed/20260606-one-mac-many-sessions.md) | `86ec8ec312cc` |
| `plan/16-mirror-cache.md` | [`docs/plans/completed/20260521-mirror-cache.md`](../plans/completed/20260521-mirror-cache.md) | `af8548a726e2` |
| `plan/17-rooms.md` | [`docs/plans/completed/20260521-rooms.md`](../plans/completed/20260521-rooms.md) | `50c349524567` |
| `plan/18-model-in-tile.md` | [`docs/plans/completed/20260521-model-in-tile.md`](../plans/completed/20260521-model-in-tile.md) | `0956a74ccc57` |
| `plan/19-agent-network-rfc.md` | [`docs/plans/completed/20260521-agent-network-rfc.md`](../plans/completed/20260521-agent-network-rfc.md) | `50c349524567` |
| `plan/19-agent-network-skill.md` | [`docs/reference/history/20260521-agent-network-skill.md`](history/20260521-agent-network-skill.md) | `f97ab51fb6f3` |
| `plan/19-agent-network.md` | [`docs/plans/completed/20260521-agent-network.md`](../plans/completed/20260521-agent-network.md) | `50c349524567` |
| `plan/20-agent-tools.md` | [`docs/plans/completed/20260522-agent-tools.md`](../plans/completed/20260522-agent-tools.md) | `776742124fcc` |
| `plan/21-setup-wizard.md` | [`docs/plans/completed/20260522-setup-wizard.md`](../plans/completed/20260522-setup-wizard.md) | `776742124fcc` |
| `plan/22-site-mvp.md` | [`docs/plans/completed/20260522-site-mvp.md`](../plans/completed/20260522-site-mvp.md) | `57ca40225a16` |
| `plan/23-owner-key-sync.md` | [`docs/plans/completed/20260523-owner-key-sync.md`](../plans/completed/20260523-owner-key-sync.md) | `3737c1136150` |
| `plan/24-mesh-membership.md` | [`docs/plans/completed/20260523-mesh-membership.md`](../plans/completed/20260523-mesh-membership.md) | `3737c1136150` |
| `plan/25-pc-mesh-bootstrap.md` | [`docs/plans/completed/20260524-pc-mesh-bootstrap.md`](../plans/completed/20260524-pc-mesh-bootstrap.md) | `b0794a85e4fd` |
| `plan/26-daemon-mode.md` | [`docs/plans/completed/20260524-daemon-mode.md`](../plans/completed/20260524-daemon-mode.md) | `f2bca2e2f5d2` |
| `plan/27-pre-publish-cycle.md` | [`docs/plans/completed/20260524-pre-publish-cycle.md`](../plans/completed/20260524-pre-publish-cycle.md) | `749d3ea1b46f` |
| `plan/28-pi-commands.md` | [`docs/plans/completed/20260528-pi-commands.md`](../plans/completed/20260528-pi-commands.md) | `b2faebe491d7` |
| `plan/29-voice-input.md` | [`docs/plans/completed/20260530-voice-input.md`](../plans/completed/20260530-voice-input.md) | `48bf537367df` |
| `plan/30-image-attachments.md` | [`docs/plans/completed/20260530-image-attachments.md`](../plans/completed/20260530-image-attachments.md) | `48bf537367df` |
| `plan/31-local-ssot.md` | [`docs/plans/completed/20260530-local-ssot.md`](../plans/completed/20260530-local-ssot.md) | `48bf537367df` |
| `plan/32-working-indicators.md` | [`docs/plans/completed/20260530-working-indicators.md`](../plans/completed/20260530-working-indicators.md) | `ef0366a709d6` |
| `plan/33-site-revamp-install-tutorials-docs.md` | [`docs/plans/completed/20260531-site-revamp-install-tutorials-docs.md`](../plans/completed/20260531-site-revamp-install-tutorials-docs.md) | `1fa21e0ce24a` |
| `plan/34-mesh-reliable-delivery-passive-presence.md` | [`docs/plans/completed/20260601-mesh-reliable-delivery-passive-presence.md`](../plans/completed/20260601-mesh-reliable-delivery-passive-presence.md) | `bdd1563d99fc` |
| `plan/35-mesh-leaderless-redesign.md` | [`docs/plans/completed/20260606-mesh-leaderless-redesign.md`](../plans/completed/20260606-mesh-leaderless-redesign.md) | `86ec8ec312cc` |
| `plan/36-push-notifications.md` | [`docs/plans/completed/20260606-push-notifications.md`](../plans/completed/20260606-push-notifications.md) | `86ec8ec312cc` |
| `plan/38-mesh-structured-identity.md` | [`docs/plans/completed/20260606-mesh-structured-identity.md`](../plans/completed/20260606-mesh-structured-identity.md) | `86ec8ec312cc` |
| `plan/39-daemon-cron.md` | [`docs/plans/completed/20260607-daemon-cron.md`](../plans/completed/20260607-daemon-cron.md) | `a5e65efdab61` |
| `plan/40-windows-supervisor.md` | [`docs/plans/completed/20260607-windows-supervisor.md`](../plans/completed/20260607-windows-supervisor.md) | `6dd6d681bc61` |
| `plan/41-room-per-cwd-name.md` | [`docs/plans/completed/20260608-room-per-cwd-name.md`](../plans/completed/20260608-room-per-cwd-name.md) | `3484cd8da8be` |
| `plan/42-ask-user-cancel.md` | [`docs/plans/completed/20260610-ask-user-cancel.md`](../plans/completed/20260610-ask-user-cancel.md) | `4e0abc15c33a` |
| `plan/43-app-steering.md` | [`docs/plans/completed/20260610-app-steering.md`](../plans/completed/20260610-app-steering.md) | `e7af013ab2ce` |
| `plan/44-app-android-apk-release.md` | [`docs/plans/completed/20260612-app-android-apk-release.md`](../plans/completed/20260612-app-android-apk-release.md) | `21ef01584b09` |
| `plan/47-android-queued-editing.md` | [`docs/reference/history/20260626-android-queued-editing.md`](history/20260626-android-queued-editing.md) | `feed4e5c7b08` |
| `plan/49-cli-image-preview.md` | [`docs/plans/completed/20260708-cli-image-preview.md`](../plans/completed/20260708-cli-image-preview.md) | `e85280bb16ab` |
| `plan/51-cross-pc-mesh-routing-hardening.md` | [`docs/plans/completed/20260722-cross-pc-mesh-routing-hardening.md`](../plans/completed/20260722-cross-pc-mesh-routing-hardening.md) | `846042a9a821` |
| `plan/57-app-ask-user-ui.md` | [`docs/plans/completed/20260806-app-ask-user-ui.md`](../plans/completed/20260806-app-ask-user-ui.md) | `11e8fb71af5a` |

## 已先行迁移的文档

以下沿用第一批已经确定的路径与命名；本表不重新判定其实施状态。

| 旧路径 | 新位置 |
| --- | --- |
| `plan/00-decisions.md` | [`docs/adr/20260518-closed-decisions.md`](../adr/20260518-closed-decisions.md) |
| `plan/61-pwa-scope.md` | [`docs/plans/active/20260822-pwa-scope.md`](../plans/active/20260822-pwa-scope.md) |
| `plan/62-pwa-architecture.md` | [`docs/plans/active/20260822-pwa-architecture.md`](../plans/active/20260822-pwa-architecture.md) |
| `plan/63-pwa-message-duplication.md` | [`docs/plans/active/20260823-pwa-message-duplication.md`](../plans/active/20260823-pwa-message-duplication.md) |
| `plan/64-pwa-hardening.md` | [`docs/plans/active/20260824-pwa-hardening.md`](../plans/active/20260824-pwa-hardening.md) |
| `plan/65-pwa-image-attachments.md` | [`docs/plans/active/20260827-pwa-image-attachments.md`](../plans/active/20260827-pwa-image-attachments.md) |
| `plan/66-ui-component-library-migration.md` | [`docs/plans/completed/20260828-ui-component-library-migration.md`](../plans/completed/20260828-ui-component-library-migration.md) |
| `plan/67-pwa-automated-testing.md` | [`docs/plans/completed/20260830-pwa-automated-testing.md`](../plans/completed/20260830-pwa-automated-testing.md) |
| `plan/68-pwa-ui-quality-roadmap.md` | [`docs/plans/completed/20260829-pwa-ui-quality-roadmap.md`](../plans/completed/20260829-pwa-ui-quality-roadmap.md) |
| `plan/69-remove-agent-mesh-and-rework-daemon.md` | [`docs/plans/completed/20260829-remove-agent-mesh-and-rework-daemon.md`](../plans/completed/20260829-remove-agent-mesh-and-rework-daemon.md) |
| `plan/70-revoke-peer-stop-lifecycle-gap.md` | [`docs/plans/completed/20260902-revoke-peer-stop-lifecycle-gap.md`](../plans/completed/20260902-revoke-peer-stop-lifecycle-gap.md) |
| `plan/71-pairing-transaction-atomicity-gap.md` | [`docs/plans/completed/20260904-pairing-transaction-atomicity-gap.md`](../plans/completed/20260904-pairing-transaction-atomicity-gap.md) |
| `docs/deployment-self-hosted.md` | [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) |
