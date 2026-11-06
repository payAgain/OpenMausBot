# W5：主动事件与外部渠道验收

日期：2026-11-05。分支：`personbot/dsh-foundation`。环境：macOS arm64、Node.js 26.10.0、pnpm 10.33.0；dsh 保持 `0.2.2-rc.1`。

## 可用入口与交付范围

Personbot 页面的“事件与渠道”提供来源、写入式令牌、任务订阅、一次性或固定间隔触发、事件记录和 HTTP 回传处理。首个外部 Source 是通用 Bearer Webhook，供任意外部适配器提交 `{eventId,threadId,text}`。来源会话、任务目标、验收条件、回调目的地由 owner 配置；外部输入不接受权限、Task 控制、审批或模型参数。来源默认关闭，需显式启用。产品使用步骤见[运行说明](../personbot-runtime.zh-CN.md)。

业务实现分为 `personbot-integrations` 的持久收件箱、订阅和回传 Outbox，现有 TaskRuntime 的唯一调度入口，以及 dsh 的原生 worker。没有增加模型/工具循环，也没有开启 dsh 独立自动调度器。通用集成不依赖旧引擎或旧 Chief 分派。

## 状态与恢复边界

| 场景 | 已实现行为 |
|---|---|
| 同事件重复或 HTTP 回执丢失 | 相同来源和稳定事件 ID 重放原接受回执；不同正文/线程冲突，任务身份不改变 |
| 新线程消息同时到达 | 首个接受事务预留自动订阅和 Task ID，后续事件绑定同一任务 |
| 同线程扇出、多线程订阅 | 显式同来源会话授权下关联 Task；绑定固定，旧历史不能通过改绑回传到新线程 |
| 活动任务事件 | 先保存补充及 effect，再通过原生 steer 投递；同 worker、同 Execution |
| 等待任务事件 | 先确认原执行树停止，再创建同 worker 的新 Execution；异步停止后再次核对来源和订阅 |
| 暂停、受阻、失败、待验收 | 事件保留 pending；人工继续/修改后处理，不能外部验收或解除暂停 |
| 完成或终止 | 新事件标记忽略，不创建替代任务 |
| 收件箱中有大量挂起事件 | 按 Task 排除挂起状态，并按持久顺序及游标公平取批，不能长期阻塞后面的来源 |
| 定时事件 | 和其他 Trigger 统一入库；一次性原子关闭，错过周期合并为最近一个；服务启动恢复，无需先打开 App |
| 可幂等远端回传 | 发送前保存 sending，网络和进程崩溃后复用同 ID、目标与正文，远端以幂等键去重 |
| 不支持幂等的未知回传 | uncertain 跨重启保存；不自动重发，需人工确认送达或选择可能重复的重试 |
| 回传顺序 | 同来源线程旧投递未解决时，后续保持排队；App 原生通知的确认不覆盖外部回执 |
| 禁用和重新启用 | 停止新事件/待投递事件与未来结果扇出；已入库回调仍按冻结投递生命周期推进。重新启用订阅建立新的结果时间边界 |

回调 `2xx` 是远端收到的确认，不证明其后续业务操作完成。实际幂等依赖远端遵约，不承诺通用远端恰好一次。HTTP 回调不跟随重定向，HTTPS 或本机回环 HTTP 之外的明文目标拒绝。来源令牌仅保存哈希，不进入快照、原生事件正文、回执或验证证据。

## 隔离与检查

全部行为验证使用临时 HOME/DSH_HOME、独立工作区、确定性模型、受控真实 dsh 进程和回环 HTTP 模拟接收方。浏览器运行独立 profile；没有访问 live App、个人浏览器、凭据、真实来源账号或发送真实外部消息。测试完成后停止精确拥有的进程并删除临时数据；保留测试日志和截图作为证据。

```sh
pnpm personbot:test
pnpm exec vitest run \
  src/lib/personbot-client.test.ts \
  src/components/personbot/PersonbotTasks.test.ts \
  src/components/personbot/PersonbotArtifacts.test.ts \
  src/components/personbot/PersonbotIntegrations.test.ts \
  src/components/personbot/PersonbotView.test.ts \
  server/routes/personbot.test.ts \
  scripts/control-omb.test.ts \
  src/components/SidebarFooterNav.test.ts \
  scripts/testing/verification-docs.test.ts
pnpm exec vitest run scripts/testing/personbot-events-ui.e2e.test.ts
pnpm exec vitest run scripts/testing/personbot-background.test.ts
pnpm exec vitest run scripts/testing/personbot-ui.e2e.test.ts \
  scripts/testing/personbot-tasks-ui.e2e.test.ts \
  scripts/testing/personbot-personal-ui.e2e.test.ts
```

真实原生测试包含：重复事件只有一个 Task；同线程等待唤醒保持 worker；新线程连续事件只预留一个任务且补充各入原生一次；人工暂停事件跨重启保存；离线收件箱与一次性调度恢复；实际 SIGKILL 中断发送后复用幂等 ID；未知发送不自动再次投递及人工回执重放。

独立审查先稳定复现了三项失败：64 个挂起事件阻塞后续来源、等待 native stop 期间禁用来源仍唤醒、同窗口禁用订阅仍唤醒。修复后全部通过，并增加关闭期间停止等待的持久性回归。订阅改绑与历史结果时间边界由 Store 专门回归覆盖。

测试数量、最终构建/类型/lint/依赖安装状态、浏览器截图与精确进程清理记录见[机器检查清单](evidence/personbot-events-2026-11-05/checks.json)。

| 检查 | 结果 |
|---|---|
| Personbot 包和实际原生 dsh 流程 | 199/199 通过 |
| 客户端、组件、HTTP、导航、fixture 与文档 | 9 个文件，115/115 通过 |
| W2–W4 原有真实浏览器回归 | 3 个文件，5/5 通过 |
| W5 事件与渠道真实浏览器 | 1/1 通过；1440、768、390 宽度，控制台错误 0 |
| 服务重启后无 HTTP 请求的后台调度 | 1/1 通过 |
| TypeScript、定向 lint、前端及服务端构建、冻结离线安装 | 通过 |

## 明确限制

- 未验证真实模型质量、真实服务账号、专用供应商验签、回调认证、桌面打包或跨平台发行。
- 固定间隔是同线程的周期事件，已完成或终止后不创建独立的新作业；未实现 cron、工作日限制或夏令时墙上时间规则。
- Source/订阅关闭不撤销已发生副作用；停止活动 worker 仍需使用任务暂停/终止。
- 来源最多 32、定时 128、订阅 256；事件正文 32 KiB，待处理事件 2048，未解决回传 4096。配置或收件箱达到预算时原子拒绝新增；回传满时保留未扇出的业务更新，已有投递继续排空，腾出空间后再推进。
- 事件/回传快照各最多 100 条，并进一步限制为约 7 MiB；回传优先保留需要人工处理的旧回执，字节不足时先裁减事件和普通回传。完整记录仍在 SQLite。尚无历史分页、自动归档、跨机器备份协调或生产容量验收。
- 周期任务需要服务和 runtime 在线；停机期间不执行推理。旧 App 的自动化和引擎入口仍保留，旧系统切换属于 W6。
