# 产品背景与术语

## 产品与使用场景

Remote Pi 让用户从浏览器连接 Host 电脑上的 Pi，发送输入并查看会话输出。浏览器 PWA 是控制与阅读入口，实际会话由 Host 上的 Pi runtime 执行，Relay 负责两端之间的注册与路由。

产品入口是 `/app`，根路径 `/` 在服务端重定向到该路由。NextJS 提供页面路由、构建和 PWA 相关能力，不是账号系统或业务 API 后台。

常见使用过程是：

1. 在浏览器中与一台 Host 电脑配对；使用其他电脑时，分别建立配对关系。
2. 选择该电脑上的 endpoint，进入它当前的 Pi session。
3. 发送文本或图片，查看流式输出与正式输出。
4. 按需使用有界的 typed actions，包括选择模型、调整 thinking、compact、new 和 cancel。

需要无人值守生命周期管理时，可以使用可选的 daemon 管理显式注册的 RPC child。它不是所有 Pi 交互的必经中转。安装和操作命令见[项目入口](../README.md)与 [daemon 指南](../pi-extension/docs/daemon.md)。

## 核心概念

| 术语 | 含义与边界 |
|---|---|
| Owner | 当前 browser profile 的控制方身份，不是云账号。 |
| device | Host 电脑的身份，是配对关系的范围。 |
| endpoint | 可路由的 Pi 入口；选择 endpoint 与建立 device 配对是独立步骤。 |
| runtime | Pi 的一次进程实例，不等同于 endpoint 或 session。 |
| session / history generation | 标识并隔离权威会话时间线；不能用进程名称、工作目录或其他展示资料代替。 |
| 配对 | 当前浏览器与某台 Host 建立的 device-scoped 关系，不是浏览器之间的身份同步。 |

工作目录（`cwd`）、名称、PID 和 model 都是 metadata，不是上述身份的替代品。endpoint 与 runtime 的重启关系见[架构说明](ARCHITECTURE.md#daemon-生命周期)。

`/new` 只替换 session 和 history generation，不更换 endpoint 或 runtime。Remote Pi 不提供远程历史 Pi session 的浏览或 resume 列表；当前 session 的历史输出与历史 session 列表是不同能力。

## 本地数据与信任边界

浏览器、Host 和 Relay 各自拥有不同的状态。浏览器保存当前 profile 的身份、设备与 endpoint 资料，以及有界的正式时间线缓存；Host 保存本机身份、Owner 配对资料、daemon 意图、Cron 和 Pi session。具体存储所有权见[架构说明](ARCHITECTURE.md#状态与持久化所有权)。

本地缓存不等于云端备份，也不是实时在线状态的证明。离线读取仅限已经缓存的页面壳与正式历史窗口，不能保证从未在线访问过的浏览器也能启动应用。发送输入需要在线链路，产品不提供离线发送队列。

TLS 不等于应用层端到端加密（E2E）；Relay 运营方具有观察能力，配对资料与密钥属于各端本地状态。普通 Pi 会话还会涉及模型调用，不能据此宣称消息绝不离开电脑、不会经过第三方或 Relay 绝不可能看到明文。具体信任边界以[协议入口](../PROTOCOL.md)为准。

## 非目标

当前产品不提供以下能力：

- 云账号、Vault、身份云恢复或多端身份同步。
- 会话历史云同步，以及远程历史 Pi session 的浏览与 resume 列表。
- Mesh 或 Pi-to-Pi 路由。
- 浏览器后台可靠执行、离线发送，以及锁屏后持续连接或 Web Push 的保证。

产品以 `/app` PWA 为入口，不恢复独立官网或原生客户端。

## 继续阅读

- [架构说明](ARCHITECTURE.md)：当前三端职责、状态所有权、会话数据流与缓存边界。
- [设计系统](DESIGN.md)：当前界面设计规则；未来主题方案不等于当前实现。
- [协议入口](../PROTOCOL.md)：身份、配对、消息与信任边界；详细定义见[会话协议](reference/protocol/protocol-v2.md)和[配对协议](reference/protocol/pairing.md)。
- [部署说明](DEPLOYMENT.md)：服务部署、配置与运维流程。
- [路线图](ROADMAP.md)：已确定事项及项目级状态；本文不维护开发进度。
