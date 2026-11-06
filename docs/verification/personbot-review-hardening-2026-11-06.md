# Personbot 后台任务加固验收

日期：2026-11-06。源码版本：`personbot-2026.11.06.1`，分支：`personbot/dsh-foundation`。

本记录对应代码 review 后的实际修改与隔离验收。它包含此前尚未提交的官方 Super Agent 集成，并以本轮源码、日志和证据为准；不把早期 W0–W6 或上一份官方集成记录当成本轮重新运行的结果。

运行环境为 macOS arm64、Node 26.10.0、pnpm 10.33.0、DSH 0.2.2-rc.1。官方 Super Agent 来源固定为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，来源、MIT 许可证和行为补丁见[上游说明](../../packages/personbot-superagent/UPSTREAM.md)。Node 的依赖声明与本次实际测试版本是不同概念；本记录不证明其他 Node/操作系统组合。

所有变更验证使用临时 HOME、原产品数据、DSH home 和工作目录。没有向用户正在使用的 App、演示或实际数据发送变更请求。执行链使用真实官方 Runtime 和原生 DSH，模型由确定性 fixture 提供；这些结果不替代真实模型账号、模型质量或供应商账单验收。

## Review 对应的实现

| 问题 | 本轮实现 | 主要证据 |
|---|---|---|
| 后台审批依赖当前输入 | request、task、decision 分开管理；原卡片持久投影；输入结束和后续消息不撤销仍有效审批；重放失效状态不依赖内存中的上一轮 decision | [后台授权](evidence/personbot-review-hardening-2026-11-06/hardening/background-authority/evidence.json)、driver 回归 |
| 记忆缺少调用者和请求授权 | native 提供真实 Agent/request/source/version；worker 的记忆工具只读；宿主二次校验；remember 保守引用原文，forget 要求明确直接遗忘指令 | 同一后台授权证据中的真实 `probe forget jasmine tea` 拒绝，以及 memory/usage 原生测试 |
| 修改目录复用旧进程 | context 的真实目录固定；目录改变新建 context；旧任务保留原目录；审批显示实际目录；恢复拒绝重定向或消失的原目录 | 后台授权证据中的 A/B 文件检查、原生目录回归 |
| 多 worker 修改同一目录 | 跨宿主进程共享写窗口；Git 根、符号链接和非 Git 父子目录协调；异常写窗口持久隔离，只有本人明确检查后解除 | [设置与真实崩溃](evidence/personbot-review-hardening-2026-11-06/settings/evidence.json)、host/native 回归 |
| 必须新输入才恢复 | 启动扫描未完成任务与 Outbox，按限制和退避唤醒官方 Runtime；实际任务/审批/投递/租约共同决定回收 | [自动恢复](evidence/personbot-review-hardening-2026-11-06/hardening/automatic-recovery/evidence.json)、恢复两项工作流 |
| 缺少统一资源与用量 | 主助手、worker、upkeep 共享模型槽与额度；稳定 usageId 写原账本；任务独占与 context 共享开销分开；缓存写入计入汇总，未知费用为 null | 后台授权的资源与任务用量 API、原账本原生测试 |

原聊天、侧栏、会话、记忆编辑与手机网页布局保留。界面增量位于原模型设置：模型配置、实际资源状态、能力清单和写入隔离操作。复用原确认对话框，并修正 Escape 取消隔离确认时误关整个设置的问题。没有增加新的产品壳或完整后台任务工作台。

## 生命周期与升级恢复

原 bot 和线程的 Full→Ask、单删线程、批删线程、删除 bot、回退消息分支，都在输入已经结束、后台任务仍有效的情况下验证。每项检查持久授权版本、任务结束、审批失效和恢复标记，再重启服务且不发送新消息，确认没有恢复已取消工作、启动 DSH 或执行取消的文件操作。

原生 `revoke` 在返回 Promise 前提交撤销，然后关闭已有子进程。并发提交不能把旧 context 改回 active。分支切换先验证目标，再撤销全部相关目录上下文；无效目标不会顺带取消任务。内部同步删除保留兼容接口，并有 Store 变更兜底。

任务级与请求级 Stop 均覆盖复用任务的原始及已消费输入，停止旧路由候选，同时保留其他任务仍有效的读取、审批和报告。官方 worker 完成不等于用户永久撤回其可恢复委托；明确 Stop 还必须撤回 executor-completed 任务的订阅资格，历史输入不能继续占有已经交回的新消息。

升级恢复另外验证两处边界：

- 删除临时宿主 `task_state`，保留真实官方任务库及请求/停止表，再重启。原生钩子先发布实际任务投影，再确认严格的授权 RPC，不放宽校验。
- 启动检查撤销旧 Full context 后，原会话继续发送真实新输入。新输入取得新 context 并完成，旧游标和旧授权没有重新激活。两项降权生命周期用例都包含这项续聊检查。

## 最终检查

| 命令与范围 | 实际结果 | 日志 |
|---|---:|---|
| `pnpm personbot:official:test`，原生运行时/记忆/投递/投影/账本 | 71/71 通过，0 跳过 | [完整日志](evidence/personbot-review-hardening-2026-11-06/checks/official-tests.log) |
| 同一命令中的 12 个 Vitest 文件，含 driver、原路由、设置、账本与启动器 | 166/166 通过 | 同上 |
| `pnpm personbot:official:e2e`，5 个文件 | 12/12 通过 | [完整日志](evidence/personbot-review-hardening-2026-11-06/checks/official-e2e.log) |
| 官方 core-engine/store/outbox/delivery/runtime/runtime-concurrency/model-surface，7 套 | 309/309 通过 | [上游日志](evidence/personbot-review-hardening-2026-11-06/checks/upstream-tests.log) |
| 原 bot/task/channel 批量删除，显式 legacy fixture | 10/10 通过 | [原接口日志](evidence/personbot-review-hardening-2026-11-06/checks/legacy-bulk-e2e.log) |
| `pnpm personbot:build`，含原产品与 native 两套类型检查、独立前端构建 | 通过 | [构建日志](evidence/personbot-review-hardening-2026-11-06/checks/build.log) |
| `pnpm lint` | 通过 | [lint 日志](evidence/personbot-review-hardening-2026-11-06/checks/lint.log) |

子集的 35 个 native package 用例、3 个 plugin 用例等已经包含在上表中，不重复相加。这里只声明列出的检查，不声明整个上游产品、全部 CLI 或桌面打包测试通过。

12 个端到端工作流为：原界面完整连续会话、attention/clarification 恢复、崩溃审批与原 Stop、后台授权/目录/记忆/用量、无新输入自动恢复、六种产品生命周期，以及原设置中的真实隔离与解除。

启动器曾在退出时返回 `kill EPERM`。现在对自己创建的进程组使用实际进程状态复核，只有确认没有运行中的进程才视为清理完成；仍存活且无权处理的目标不会被静默放过。启动器用例注入空组探测的 EPERM，保留真实启动/退出、顽固子进程和无关进程保护断言。[清理结果](evidence/personbot-review-hardening-2026-11-06/checks/launcher-normal-exit.json)与[原错误](evidence/personbot-review-hardening-2026-11-06/regressions/launcher-empty-group.before-fix.json)均保留。

## 原界面证据

- [完整原 App 工作流](evidence/personbot-review-hardening-2026-11-06/product/evidence.json)
- [原设置与隔离操作](evidence/personbot-review-hardening-2026-11-06/settings/evidence.json)
- [1440 像素原设置](evidence/personbot-review-hardening-2026-11-06/settings/original-settings-1440.png)
- [768 像素原设置](evidence/personbot-review-hardening-2026-11-06/settings/original-settings-768.png)
- [390 像素原设置](evidence/personbot-review-hardening-2026-11-06/settings/original-settings-390.png)
- [手机宽度的确认对话框](evidence/personbot-review-hardening-2026-11-06/settings/reconcile-confirmation-390.png)

设置检查确认无横向溢出、取消默认获得焦点、Escape 保留隔离且不关闭设置、明确确认后才调用真实解除接口。原 App 工作流另保存桌面/手机聊天截图和布局几何。截图中的用户、记忆、任务和用量均为 fixture 合成数据。

## 失败保留与可复核性

修复没有删除失败断言或把已知失败改成超时容忍：

- [原连续会话停止失败](evidence/personbot-review-hardening-2026-11-06/regressions/original-product-request-stop.before-fix.json)：实际只有两个 ticket；不是“已证明创建第三个任务”，而是旧完成任务仍保留订阅，后续消息没有正式回复。
- [单任务停止失败](evidence/personbot-review-hardening-2026-11-06/regressions/task-stop.before-fix.log)：停止后连续两次新输入的回归。
- [旧投影恢复失败](evidence/personbot-review-hardening-2026-11-06/regressions/legacy-projection-recovery.before-fix.log)与[相同加强用例的通过结果](evidence/personbot-review-hardening-2026-11-06/checks/legacy-projection-recovery.log)。

[环境信息](evidence/personbot-review-hardening-2026-11-06/environment.json)、[源码散列清单](evidence/personbot-review-hardening-2026-11-06/source-manifest.json)和[12 组工作流证据索引](evidence/personbot-review-hardening-2026-11-06/evidence-index.json)随源码保存。文本日志中的仓库绝对路径统一写作 `<repo>`；临时 fixture 路径与合成数据保留。运行数据库、实际凭据、node_modules、构建产物与根研究 checkout 不作为发布文件。

## 尚未证明或尚未实现

- 实际模型账号、真实长任务质量、供应商最终账单、正式手机配对/companion、桌面安装包和其他操作系统仍需单独验收。
- 写窗口保守覆盖整个 worker，部分分析并行会受限；不是 OS 文件沙箱，不阻止外部程序或越出声明目录的操作。
- DSH 可能启动私有 detached 工具进程。quarantine 是保守暂停与本人核查，不保证所有外部进程都被清除，也不保证任意外部副作用跨崩溃恰好执行一次。
- Git 每任务 worktree、显式合并、非 Git 输出交付、一键配套备份仍未实现。备份需包括原产品数据、Personbot home、宿主资源库三个部分。
- 原 Connected Apps、桌面/浏览器工具、旧自动化、App 插件安装器与外部 DSH 网关尚未全部接入。原设置读取后端能力清单，但不声明每一张旧设置页面都已完成迁移。
- 用量基于 adapter 实际报告。未知 USD 为 null；独占任务汇总不包含其旁列的共享 context 开销。已开始调用可结束并超过观察额度；原账本和 Store 辅助计数之间仍有跨存储崩溃投影窗口。

操作与设计细节见[加固说明](../personbot-review-hardening.zh-CN.md)、[运行时](../personbot-runtime.zh-CN.md)和[记忆设计](../personbot-memory-design.zh-CN.md)。
