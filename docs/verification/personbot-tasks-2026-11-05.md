# Personbot 长期任务与 App 验收

日期：2026-11-05。分支：`personbot/dsh-foundation`。运行环境：macOS arm64、Node.js 26.10.0、pnpm 10.33.0，锁定 `@deepseek-ai/dsh@0.2.2-rc.1`。

本记录验收 W3 的 App 工作流。原生聊天与网关的历史验收见 [W2 记录](personbot-app-2026-11-05.md)，运行方式与架构边界见[运行说明](../personbot-runtime.zh-CN.md)。

## 任务入口

Personbot 对话上方的“长期任务”区域允许创建任务，必须填写目标和逐项完成条件，可补充明确的任务上下文。任务使用独立的原生 worker Session，主聊天仍可继续响应。通过任务卡可以查看 worker 工具轨迹、处理原生审批和提问、暂停、继续、终止、要求修改和验收。

worker 报告只会进入“等待验收”。报告后的原生执行树还需要确认停止，确认前禁止验收、修改和恢复。用户核对完成条件和证据后点击“验收通过”，才会将任务标记为完成。停止无法确认时，任务卡提供“重试停止任务”；业务已终止的任务也保留这一入口，并提示原有操作结果仍需核对。worker 会话不提供普通输入和原生 Stop，浏览器恢复历史也不会自动 resume worker，后续执行由监督层控制。

任务状态、Execution、报告与结果回传收据来自监督层持久快照。后台结果保存在持久 Outbox，由运行时在来源会话允许的时机投递，不单独触发主聊天的模型轮次；任务卡立即显示报告及回传状态，下一次用户聊天会读取监督通知。历史 Execution 的外部操作结果未知时，即使任务已经终止且当前执行树确认停止，任务卡仍保留核对提示。

## 隔离验证方式

```sh
pnpm exec vitest run \
  src/lib/personbot-client.test.ts \
  src/components/personbot/PersonbotTasks.test.ts \
  src/components/personbot/PersonbotView.test.ts

pnpm exec vitest run \
  scripts/testing/personbot-ui.e2e.test.ts \
  scripts/testing/personbot-tasks-ui.e2e.test.ts
```

浏览器使用现有固定版本工具，缺少浏览器时可通过 `OMB_UI_E2E=1` 显式安装。测试由 `launchVerificationServer` 的程序化布尔参数启用 Personbot fixture，将 App server、Chrome profile、native dsh home 和 workspace 全部限制在临时目录。模型为确定性的 `personbot-fixture / fixture`；不透传个人 API key、`DSH_HOME` 或个人 Personbot 配置。

## 客户端与组件验证

客户端与组件测试 24/24 通过，前端 TypeScript 和相关 oxlint 检查通过。覆盖稳定任务命令重试、明确版本冲突后的新命令、已接受操作与刷新失败的区分、worker 的原生输入/Stop/resume 防绕过、主聊天可用、待验收证据、未知结果提示、报告后的停止确认门槛、open/cancelled 任务的停止重试、终止后保留历史副作用未知提示及完成后的按钮收束。

## 最终整体验证

| 检查 | 结果 |
|---|---|
| `pnpm personbot:test` | 121/121；包括 17 项真实原生任务集成、27 项 Supervisor Store 测试与 2 项运行时 effect 回归 |
| 客户端与任务/会话组件 | 24/24 |
| HTTP/SSE 路由、导航、control launcher、隔离 fixture 与文档引用 | 60/60，5 个测试文件 |
| 两套完整浏览器工作流与环境隔离检查 | 4/4 |
| 前端、server 与 Personbot TypeScript | 通过 |
| Personbot packages、client/UI、routes、浏览器 recipe 的 focused oxlint | 通过 |
| `pnpm build`、`pnpm build:server` | 通过；前端仍有生成 CSS 伪元素优化与大 chunk 警告 |
| `git diff --check` | 通过 |

命令与结果见[检查清单](evidence/personbot-tasks-2026-11-05/checks.json)，原始完整输出保留为[包级测试日志](evidence/personbot-tasks-2026-11-05/native-tests.txt)与[路由及 fixture 测试日志](evidence/personbot-tasks-2026-11-05/routes-fixture-tests.txt)。

原生任务测试验证了以下收尾与恢复边界：

- 五项任务同时创建时最多运行四个 worker 根；第五项在原任务确认停止后启动，主聊天仍能响应。
- 终态报告持久排队 seal，停止受控后台 OS 进程与正在等待模型的子 Agent，不再增加根模型请求。
- 正常委派时，根的临时 idle 等待原生 child 回传，在同一个 Execution 内继续；等待不持有任务控制锁，pause/cancel 能及时停止 child。
- 在运行、已请求停止，以及已报告但尚未确认 seal 的窗口中断，历史副作用都保留未知；后两个窗口由持久 Store 回归直接验证。新进程的本地停止确认不能清除前进程的不确定性。
- 过期 seal 不会对复用 Session 的新 Execution 调用原生停止；关闭期间保留拒绝工具执行的 guard，直到原生树清理完成。
- 来源会话执行期间通知保留在 Outbox，空闲后注入 `next-step`；下一次正常输入与通知同轮消费。受控场景中两次用户输入只有两轮、两次模型请求，通知只消费一次。

macOS 的受控后台进程确实能在 runtime SIGKILL 后存活，测试按确切 PID 清理；因此这些检查不承诺新运行时能发现或终止任意旧进程。停止/报告落库后的崩溃窗口通过 Store 回归验证状态规则，没有将它们计入浏览器覆盖。

## 真实浏览器工作流

最终合并回归 4/4 通过：两项 fixture 环境隔离检查、原生聊天完整浏览器工作流与长期任务完整浏览器工作流。任务工作流覆盖以下闭环：

1. 从 App 创建 `task-hold`，填写两项完成条件和隔离上下文；服务端接受后故意丢弃响应，重试使用同一 taskId/commandId，只有一项任务。
2. worker 保持执行中，来源会话的 `echo main-chat-during-task` 仍能得到回答。
3. 打开任务会话后没有普通聊天输入或原生 Stop；暂停等待执行结束，再继续，得到新的 Execution，worker Session 与两次业务输入历史保持连续。随后终止任务，状态持久为 cancelled。
4. `task-review` 提交报告和 `fixture:verified` 证据后仍然 open/awaiting_review；点击“验收通过”才成为 completed。故意丢弃验收响应后，已完成状态仍能通过快照恢复。
5. `task-question` 进入 waiting_person，切到 worker 原生问题卡，选择 Markdown 并提交，继续运行至 awaiting_review。
6. `task-wait` 进入 waiting_event；点击“继续任务”后复用 Session、建立新 Execution 并提交报告。所有本地结果 Outbox 收据最终 delivered。
7. 在新的用户输入前，来源 Session 的原生日志里没有消费监督通知。发送下一条普通消息后，任务结果以 `personbot-task-result` 通知显示在主聊天中。
8. reload 恢复相同任务状态、Execution、报告与回传收据。
9. 保持四个任务，在 1440、768、390 宽度检查任务区域、按钮和主输入框无横向溢出。手机等待侧栏完成收起，标题避开导航按钮；人工查看三种尺寸截图与完整待验收报告截图。
10. 浏览器 console 无 error。测试关闭自己的浏览器、server 与精确 dsh PID，并确认临时数据目录已删除。

仓库中的证据：[验证数据](evidence/personbot-tasks-2026-11-05/evidence.json)、[待验收报告](evidence/personbot-tasks-2026-11-05/task-awaiting-review.png)、[桌面](evidence/personbot-tasks-2026-11-05/personbot-tasks-1440.png)、[平板](evidence/personbot-tasks-2026-11-05/personbot-tasks-768.png)、[手机](evidence/personbot-tasks-2026-11-05/personbot-tasks-390.png)。

原始证据及 server 日志：

```text
/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/
  server-1793875249756-15142.log
  server-1793875249756-15142.log.personbot-tasks/
```

同轮原生聊天回归的原始证据位于同一目录下的 `server-1793875266343-15470.log.personbot/`，包含原生进程强杀重连、审批文件效果、问题回答、Stop、首次入口与三种尺寸截图。W2 文档保留原阶段的历史证据。

17 项原生任务集成还覆盖真实受控文件审批、拒绝写入、SIGKILL 后 unknown/blocked、明确恢复、无报告/无证据拒绝、定时唤醒与持久 Outbox。App 浏览器验收不把这些未直接操作的分支计入浏览器覆盖。

## 验收边界

测试验证确定性 fixture 下的状态、并发会话和 App 操作，不验证真实模型的任务质量。完成条件与证据由用户验收，当前未提供通用自动判定正确性的机制。

结果回传目标是本地 Personbot 来源会话，未接入真实外部账号或远端消息渠道。产物字节、下载和预览服务继续属于 W4。App 的旧引擎路径和桌面分发打包仍保留原有阶段边界。
