# 官方 Super Agent 运行时集成

本文对应原 OpenMausBot 界面接入固定官方源码的新路径。早期 W0–W6 自建协议/监督器的完整说明保存在 [历史运行时文档](archive/personbot-runtime-before-official.zh-CN.md)。`pnpm personbot` 目前仍是那个实验协议的终端入口；本阶段产品入口是 `pnpm personbot:start`，两者不能被混称为同一后端。

## 模块

| 模块 | 职责 |
|---|---|
| `server/superagent-driver.ts` | 原 ProviderDriver 端口、输入轮次与后台事件分离、独立审批、目录 context 和定向停止 |
| `shared/superagent.ts` | 可信绑定、调用者、授权版本、任务/审批/用量事件及快照契约 |
| `packages/personbot-superagent/src/index.ts` | 持久私有绑定、请求授权、审批/任务投影、子进程 RPC、自动恢复、配置切换和空闲回收 |
| `packages/personbot-superagent/src/host-resources.ts` | 共享 SQLite 模型入场、写租约、累计额度与精确进程归属清理 |
| `packages/personbot-superagent/src/launch.ts` | 固定 DSH 版本、隔离 profile、官方主/worker preset 和插件装配 |
| `packages/personbot-superagent/src/plugin.ts` | 实际上游 Runtime、OpenMausBot Source/Channel、native tools、原生审批、领域事件 |
| `packages/personbot-superagent/upstream` | 固定官方核心及可追踪个人部署适配 |
| `server/superagent-memory.ts` | 原记忆/FTS/journal/遗忘桥接与来源校验 |
| `server/superagent-delivery.ts` | 官方 Outbox 到原消息库的事务投递、重试去重和原请求来源校验 |
| `server/superagent-projection.ts` | 后台审批、问题与任务通知到原卡片/消息的独立去重投影 |
| `server/superagent-usage.ts` | 原生主助手、worker 和记忆维护 usage 到原 JSONL 账本 |
| `server/routes/superagent.ts` | 能力、任务/审批、宿主资源查询和明确范围的停止 API |
| `server/index.ts` | 原消息生命周期和 Store 接线；禁用重复执行器，启动原记忆维护 |

## 运行时及身份

每个 `(botId, threadId, contextId)` 对应一个官方运行时 home 和固定的规范真实工作目录；主 Session 和多个 worker 都由官方核心管理。`bindings.sqlite` 记录此映射、活动分支、原请求/用户消息、授权版本、Stop 意图、任务/审批投影以及消息/用量回执。任务语义仍以官方 Store 为准，投影只管理宿主身份和生命周期。

模型工具不能自行选择 Bot 或升级调用者角色。native adapter 传入真实 `agentId/role/ticketId` 和 request；网关验证持久请求，重建 `sourceMessageId/authorizationVersion`，再交给原服务。原记忆端口还有作者、当前来源、宿主显式授权和操作证据检查。

子进程按需启动，默认最多 8 个。宿主启动同时扫描需要恢复的活动绑定，逐个按限制唤醒官方运行时，失败时退避重试；无需用户再打开或发送消息。历史中没有待办的绑定不批量启动。空闲回收同时检查当前输入、官方未结束任务、待审批、待投递和持久 Stop 意图，不能仅凭输入框空闲回收。

`omb-superagent:<contextId>` 是产品用于恢复绑定的游标，不冒充 worker 的真实 DSH Session ID。目录变化产生新的 workspace context，保留旧目录中的后台任务；编辑/回退的 branch 转换则退出旧活动分支。网关拒绝同一个 context 直接更换 cwd。模型、凭据和权限也进入进程 fingerprint，活动工作期间不能通过复用进程静默修改；worker 的权限由其来源固定，新输入不能提升旧 worker 权限。

## 独立审批与停止

输入轮次、官方任务和审批请求分别管理。driver 保留独立 decision 索引，后台任务的审批/问题/状态不再要求 `active.get(threadId)` 命中。原消息投影使用当前活动分支和持久原消息来源，卡片与通知按稳定身份去重，不改变另一轮输入的忙碌状态。

官方 Intake/followupOwners 仍可将同一线程的新输入交给当前任务。该输入可能等待 worker handback；独立生命周期保证旧审批不会消失，不承诺同一线程每个请求独立并行。新线程或独立 context 可以分别调度。

网关保存每个 pending decision 的 request、ticket、Agent、callId、授权版本和当前原生进程归属。回答前重新检查；原生工具取消、任务结束、Stop、分支退出或子进程退出会解决或使对应审批失效。服务重启不把旧 ID 视作新工具授权；官方恢复的新审批重新建卡，失效的旧卡不能批准它。

`interrupt(binding, target)` 明确区分 `request`、`task` 和 `conversation`。request 只取消消费该来源的工作；task 只取消指定 ticket；conversation 取消此会话相应活动上下文的工作。原 Stop 有明确 request 时使用 request 范围；管理 API 提供 task 与会话全部范围。

## 消息和历史

原直接消息入口保留创建用户消息、请求归属、Stop 和当前分支 bookkeeping，随后直接调用官方 driver。该分支跳过旧引擎重放、旧 compaction 和旧集成工具挂载。DSH 独立保存真实模型与工具历史。

工具轨迹来自 native Session 事件。worker 的原始 token 不直接发布成聊天答案；正式文本来自官方 Source Outbox。Source 等待原消息数据库提交成功后才返回发送成功。原命令回执与消息行在同一事务中提交，以 bot/thread/context/outbox ID 去重，服务重启后的重复投递仍返回原消息。

来源投递校验真实用户消息、当前分支与停止状态。追问后的最终结果可以独立于当前 driver 轮次入库；它不会结束另一条正在执行的新请求。任务状态使用官方 DomainEvent；没有第二套自建 TaskRuntime 同时驱动同一任务。

新绑定可以携带当前可见旧聊天的有界参考，明确标注为历史、不是新的执行授权。长期事实通过原记忆服务检索；不把完整 MEMORY.md 固定复制进 system prompt。

## 原记忆维护

原 memoryUpkeep 的模型端口接到 gateway.generateText。调用 DSH LLM 时使用单次消息、空工具列表和单独 AbortController；既不借用当前主聊天的历史，也不授予文件或执行工具。原自动提取的来源、用户证据、可见性、遗忘和过期结果规则保留。

`memory_search/read/remember/forget` 处理事实；原 About me 按当前资料读取并标为 `omb.profile`，`memory_read` 的虚拟路径 `about-me` 不打开任意文件。`task_history_search` 直接查询官方任务资源，返回任务来源；不会复制成个人事实。完整边界、证据规则和留存限制见 [记忆设计](personbot-memory-design.zh-CN.md)。

worker 默认获得读取和提出候选的能力，`memory_propose` 把不受信候选送回官方主助手，不写个人事实。写入仅向真实 master 开放；remember 保留准确原陈述，forget 检查原消息的直接遗忘请求和准确目标。原宿主 `canWrite` 还调用 `gateway.authorizeMemory`，再次核对实际初始化的 master、原来源、版本和写入撤销标记；Stop 后的旧能力不能继续写入。

## 宿主资源与用量

生产默认共享 `~/.personbot-host/host-resources.sqlite`；隔离 fixture 使用自己的资源目录。共享协调器在 SQLite 事务中处理模型槽、排队、写租约和入场额度，参与同一宿主资源目录的网关必须采用一致策略。已有拥有者运行时改变策略会明确失败。

模型槽覆盖主 Session、worker 和无工具维护的实际 `llm/stream` 调用。worker 在执行/测试/后台工作窗口持有目录写租约，主助手的变更工具也取得租约。Git 目录折算为仓库根目录，非 Git 路径检查父子重叠，符号链接使用真实路径。被停止的排队请求撤销入场；租约按准确拥有者释放，不能借一个新请求释放另一个 worker 的写锁。

活动写租约在原生进程/宿主异常死亡或被迫关闭时转为持久 workspace quarantine。重启后新的重叠写工作仍受阻，不需要写窗口的模型读取不因目录隔离而阻断。正常释放继续沿原租约流程；异常释放不会通过猜测未知外部工具 PID 自动认为文件已经安全。原设置显示隔离 ID、目录和原因，owner/admin 明确确认相关外部操作已结束并核查文件后才解除。解除只是重新允许后续写入入场，具体任务是否继续仍由官方任务状态决定。

`usage` 使用每次实际原生调用的稳定 ID。网关保存待投影事件，原账本写入并同步后才确认；回调失败或重启后重投不重复计费。原 `usage/YYYY-MM.jsonl` 保存 request、Agent/角色、ticket、token 和已报告费用，原 `/api/usage` 可继续汇总。维护记录使用明确的 helper 身份。未知价格保持 null，计为 unpriced。

模型已经入场但异常中断、尚未返回用量时，宿主保留未报告调用计数；没有供应商报告不等于已知零消费，不能据此补造 token 或完整费用。资源快照的未定价数包含这种未报告情况。

累计模型请求/token/已知费用限额阻止后续模型入场，不回滚已经开始的调用。配置美元限额后出现无法定价的调用，也会暂停后续入场。原产品月度预算在每次 native 入场前后重新检查。目录写锁、模型并发上限和预算是三种不同限制。

原账本与 Store 的辅助累计计数不是跨存储原子提交。原账本通过 usageId 去重；进程若在账本已落盘、Store 尚未更新时退出，准确查询应以账本为准，辅助计数仍需从账本重建。这不影响原 `/api/usage` 直接读取已落盘调用。

`superagent-task-usage.ts` 为单个任务从原账本重新汇总，返回已落盘的 calls、input/output/cacheReadTokens/cacheWriteTokens、knownCostUsd、unpricedCalls。顶层标为 `attribution: "ticket-exclusive"`，严格匹配 bot/thread/context/ticket。`shared` 另列同一 bot/thread/context 中没有 ticket 的记录，包含主路由开销，保留这个池的 botId/threadId/contextId，并标为 `attribution: "context-unallocated"`、`exclusive: false`、`includedInTaskTotal: false`；不按时间或请求碰巧接近来猜测分摊。这个共享池会在同一 context 的不同任务查询中重复展示，调用方应按池的身份去重，不能把它按任务再次相加。

独占与共享两个部分分别计算费用；某一部分存在未定价记录或没有记录时，该部分的完整 costUsd 为 null，knownCostUsd 只表示已知部分。未报告用量的入场状态另见宿主资源快照。

## 查询与管理 API

这些端点位于原认证之后，仅允许仍有效的 owner/admin 会话或本机 owner，不能作为新的未认证网关：

| 方法与路径 | 返回或操作 |
|---|---|
| `GET /api/personbot/capabilities` | 当前模式支持与不支持的能力及原因，原模型设置据此展示 |
| `GET /api/personbot/tasks?threadId=<threadId>` | 当前可见活动分支的官方任务投影和审批状态 |
| `GET /api/personbot/tasks/<ticketId>/usage` | 原账本的任务独占用量与单列的同 context 未分配共享开销，含缓存读写、已知费用和未定价数 |
| `GET /api/personbot/resources` | 宿主实际活动/排队模型数、调用与 token 累计、额度和未定价数量 |
| `POST /api/personbot/tasks/<ticketId>/stop` | 停止一个尚未结束的官方任务 |
| `POST /api/personbot/threads/<threadId>/stop` | 停止该会话全部可用活动上下文中的任务 |
| `POST /api/personbot/workspaces/<id>/reconcile` | 明确确认外部操作和文件已核查后解除指定写入隔离；严格要求唯一字段 `{"acknowledge":"external-processes-reviewed"}` |
| 原 `/api/threads/<threadId>/respond` | 回答准确审批/问题；过期或不再授权时返回 unavailable |
| 原 `/api/usage` 与 `/api/usage.csv` | 原账本的用量汇总和导出 |

模型设置展示后端资源快照，包含活动/排队模型数、token、额度、未定价数和隔离目录，打开时读取并可手动刷新。解除隔离复用原确认对话框，不作为 Agent 工具注册；普通调用不能省略明确确认字段。

## 模式与兼容

个人源码模式默认启用 `PERSONBOT_ENABLED=1`、`PERSONBOT_PRIMARY=1`、官方 Super Agent。启动器显式启用该组合。hosted/Cloud 和打包环境不自动切换。`PERSONBOT_SUPERAGENT=0` 保留给旧实验验收和兼容排查；不是原产品界面所需条件。

关闭个人主模式时，原多引擎行为仍可显式运行；不要同时让旧自动化和官方任务处理同一工作。官方模式不自动导入早期自有 supervisor 的 Ticket、事件订阅或新个人数据库。

当前是本机托管 DSH，未提供外部网关连接器。插件从专用 profile 装配；App 暂无插件安装器。原手机网页继续走原 API，但未声明发布版原生 companion 和真实扫码链路已完成验收。

一键备份尚未覆盖原数据目录、Personbot home 与共享宿主资源目录，详见[产品使用说明](personbot-product.zh-CN.md)。本轮加固、后续计划及升级契约见[加固设计](personbot-review-hardening.zh-CN.md)。

## 检查

```sh
pnpm typecheck
pnpm personbot:typecheck
pnpm lint
pnpm personbot:official:test
pnpm personbot:official:e2e
```

native Node 端保留 erasable TypeScript 检查。DSH loader 加载的插件和上游源码使用独立 runtime tsconfig，检查实际导入的官方源码，允许上游需要的 TypeScript 转译语法。

执行上述命令不等于已经通过。上一次集成的执行结果在[验收记录](verification/personbot-official-superagent-2026-11-06.md)；本轮生命周期和授权变更需要新的最终记录，不能把旧结果作为此次重新验收的证据。
