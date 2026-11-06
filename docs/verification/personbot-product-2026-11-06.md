# W6：Personbot 主工作台与旧系统切换验收

日期：2026-11-06（Asia/Tokyo）。分支：`personbot/dsh-foundation`。环境：macOS arm64、Node.js 26.10.0、pnpm 10.33.0；dsh 保持 `0.2.2-rc.1`。

## 交付范围

个人源码安装默认直接进入 Personbot。App 在挂载旧 StoreProvider 和 onboarding 前确认模式；独立导航提供对话、长期任务、项目与记忆、产物、事件与渠道、旧历史和模型设置。`pnpm personbot:start` 在需要时构建前端，然后从同一服务提供界面；`--demo` 用隔离临时数据运行实际 dsh 与确定性模型。使用步骤见 [产品说明](../personbot-product.zh-CN.md)。

| 场景 | 产品行为 |
|---|---|
| 新安装未配置凭据 | 展示模型设置，不先启动缺少凭据的原生客户端 |
| 保存设置、响应丢失后重试 | 稳定命令身份返回原回执，随后重新读取快照；不泄露 key |
| 模型或凭据在运行中改变 | 显示需要重启，活动运行时状态仍显示实际配置 |
| 离开对话进入设置/历史 | 保留当前会话草稿 |
| 阅读旧历史 | 分页读取，隐藏凭据/登录记录正文，附件只保留元数据 |
| 导入旧工作 | 人工确认目标和进展，固定导入计划，新建一个 dsh 会话；可选择角色和有效项目目录 |
| 导入响应丢失或冷重启 | 同一命令恢复同一会话，不重复派工 |
| 切换主模式 | 不启动旧执行器、自动化、Chief、Webhooks；旧写入和控制入口拒绝 |
| 长期任务报告 | 保留独立 worker 和执行树停止语义，人工验收才完成业务任务 |

## 隔离与复核

全部行为验证使用独立 HOME、DSH_HOME、数据目录、工作区和浏览器 profile。模型为受控 fixture，进程为实际锁定 dsh；外部事件与回调使用回环模拟服务。没有验证性访问 live App、个人浏览器、真实凭据或第三方账号。测试只停止自己拥有的精确进程，保留日志和截图作为证据。

主模式切换测试先创建旧工作区与历史，再停止旧服务，用同一份临时工作区启动 Personbot 主模式。它验证原记录可查、旧写入拒绝、导入重试保持身份、dsh 收到人工确认的进展，以及旧到期自动化和 Webhook 不启动。

独立审查发现旧队列启动恢复和旧升级连接控制路径仍可生效，以及构建中断可能留下后代进程。修复后，切换测试保存未完成旧任务、待发送队列、工作中目标卡片与旧日历记录，证明启动、读取、导入及退出均保留原记录；升级连接在目标解析前拒绝。启动器用所属进程组清理构建后代，并先给服务端机会正常关闭 dsh。首次直接演示还暴露 fixture 错误地要求旧 starter 的假设，已修正为主模式不读取或重命名旧 starter。最终结果及对应证据见 [机器检查清单](evidence/personbot-product-2026-11-06/checks.json)。

```sh
pnpm personbot:test
pnpm exec vitest run server/personbot-mode.test.ts \
  server/personbot-settings.test.ts server/routes/personbot-setup.test.ts \
  server/personbot-legacy.test.ts src/lib/personbot-product-client.test.ts \
  src/components/personbot/PersonbotProduct.test.ts
pnpm exec vitest run scripts/testing/personbot-cutover.test.ts
pnpm exec vitest run scripts/testing/personbot-start.test.ts
pnpm exec vitest run scripts/testing/personbot-product-ui.e2e.test.ts
pnpm exec vitest run scripts/testing/personbot-ui.e2e.test.ts \
  scripts/testing/personbot-tasks-ui.e2e.test.ts \
  scripts/testing/personbot-personal-ui.e2e.test.ts \
  scripts/testing/personbot-events-ui.e2e.test.ts \
  scripts/testing/personbot-background.test.ts
```

| 检查 | 结果 |
|---|---|
| Personbot 包及真实原生 dsh | 202/202 通过 |
| 客户端、组件、HTTP、模式、fixture 与导航 | 14 个文件，142/142 通过 |
| 旧模式切换、Routine、Calendar 与拒绝控制连接 | 4 个文件，215/215 通过 |
| 启动器构建中断、失败、演示与普通首次使用 | 5/5 通过 |
| W6 完整主界面真实浏览器 | 1/1 通过；原生聊天、设置重试、任务验收、历史导入与刷新恢复 |
| W2–W5 浏览器与无 App 后台调度回归 | 5 个文件，7/7 通过 |
| 最终生产界面设计检查 | 对话和设置分别在 1440、768、390 下检查，均为 0 FAIL / 0 WARN；截图已逐张查看 |
| TypeScript、定向 lint、前端及服务端构建、冻结离线安装 | 通过 |

测试组之间有重叠，不将次数相加当成独立覆盖。机器清单保存最终日志、截图、SHA-256 和进程清理证据。单独为用户保留的成品演示在清单中标记 `retainedForUser`，与已经清理的验收 fixture 区分。

## 当前边界

这次交付为本机源码 App。主模式切换覆盖个人源码环境；hosted/Cloud 与原桌面发行入口没有自动切换。旧内容只作为参考文本和有限配置导入，不导入旧引擎内部上下文、权限、凭据或自动化。设置只支持已锁定发布包中的官方 DeepSeek provider。

真实模型质量、真实渠道账号和桌面安装包不在本次验证范围。确定性演示证明消息、工具、审批、任务与恢复流程连通，不能代表通用模型推理质量。完整业务和数据边界仍以 [运行时说明](../personbot-runtime.zh-CN.md) 为准。
