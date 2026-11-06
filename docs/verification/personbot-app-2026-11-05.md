# Personbot App 与 dsh 接线验收

日期：2026-11-05。分支：`personbot/dsh-foundation`。环境：macOS arm64、Node.js 26.10.0、pnpm 10.33.0，实际运行 `@deepseek-ai/dsh@0.2.2-rc.1`。

本记录验收 W2。W0/W1 的历史结果保留在[原生运行时记录](personbot-runtime-2026-11-05.md)；源码启动步骤、配置和数据边界见[运行说明](../personbot-runtime.zh-CN.md)。

本文后续的“当前边界与后续”保留 W2 验收时点的范围。W3 已交付持久业务任务与执行、独立 worker、Effects/Outbox 和人工验收；最新结果见[长期任务验收记录](personbot-tasks-2026-11-05.md)。

## 已交付

App 侧栏新增 Personbot · dsh，覆盖简洁、完整和手机侧栏；`/personbot` 与 `#personbot` 可以直接进入，并继续使用现有认证。进入 Personbot 时不要求先完成旧引擎 onboarding。

新的路径经 `server/routes/personbot.ts`、`packages/personbot-gateway` 和已有 runtime Host 运行 dsh。gateway 延迟启动一个拥有排他 home 的运行时，允许多个原生 Session。已有旧聊天与引擎视图仍保留；Personbot 路径不通过旧 driver 派工。

App 使用 `packages/personbot-projection` 投影原生事件，支持文本、推理、关联工具参数/结果、错误与中断。临时流不会代替持久原生历史；连接恢复后逐 Session 补齐日志页，按原生 seq 去重。SSE 是临时通知通道，当前没有持久产品事件日志或 Last-Event-ID 重放。

支持批准一次/拒绝、原生问题的选项/自定义/取消、followup/steer、定向 Stop、当前会话选择保留和失败命令重试。Stop 网络结果未知时重试同一命令；收到明确失败回执后允许新 Stop 尝试。原生问题的计划或授权详情会在选项前显示。

## 自动检查

| 检查 | 本次结果 |
|---|---|
| `pnpm personbot:test` | 73/73：W0/W1 45、投影 25、gateway 3 |
| `pnpm exec vitest run server/routes/personbot.test.ts` | 15/15，HTTP/SSE 鉴权与生命周期 |
| `pnpm exec vitest run src/lib/personbot-client.test.ts src/components/personbot/PersonbotView.test.ts` | 11/11，客户端恢复/幂等与问题详情展示 |
| `pnpm exec vitest run scripts/control-omb.test.ts scripts/testing/personbot-ui.e2e.test.ts` | 9/9，环境隔离与真实 App 浏览器闭环 |
| 导航、客户端、问题卡片、接口和首次引导的定向回归（10 个文件） | 135/135 |
| `pnpm personbot:typecheck`、前端与 server 类型检查 | 通过 |
| `pnpm build`、`pnpm build:server` | 通过；Vite 仍提示部分 chunk 较大 |
| 新增/修改 Personbot 代码的 `oxlint --deny-warnings` | 通过 |

73 项包级测试包含真实 dsh HTTP gateway：延迟启动、并发创建、严格方法校验、输入幂等、工具审批的实际文件效果、原生提问、定向 Stop、旧 Stop 重试、关闭后重建 gateway 保留历史及过期审批拒绝。投影测试覆盖乱序/重叠快照、临时流结算、generation 切换、root/child 待决归属和浏览器打包边界。

路由测试使用临时 HTTP server，覆盖 owner/admin、service/client 拒绝、严格 body、错误码映射、启动等待后重新校验认证、已建立 SSE 撤销、启动期间撤销、背压和退出清理。

根 `tsconfig.json` 的类型库由 ES2022 更新为 ES2024，以匹配项目已有的 `findLast`、`toReversed`、`Promise.withResolvers` 等 API；编译目标仍为 ES2022。W0/W1 记录中的 28 条基线声明错误已解决，该历史记录保留当时结果。

## 真实 App 浏览器闭环

运行：

```sh
pnpm exec vitest run \
  scripts/control-omb.test.ts \
  scripts/testing/personbot-ui.e2e.test.ts
```

浏览器与确定性模型 fixture 均由现有验证工具管理。缺少固定版本浏览器时使用 `OMB_UI_E2E=1` 显式安装。launcher 的程序化末尾布尔参数启用 Personbot；所有运行时目录位于该 fixture 临时 home，provider/model 固定为 `personbot-fixture / fixture`，个人 key 和 `DSH_HOME` 不透传。

最后一轮完整闭环通过：

1. GET status 保持 runtime 为 stopped；通过 App 可见入口创建原生 Session。
2. 提交 echo 后，故意丢弃已经被服务端接受的响应。草稿保留，重试使用相同 commandId/messageId，最终用户消息和回答各一份。
3. 审批前文件不存在；拒绝不写文件；允许一次后真实工具写入预期内容，工具详情展示参数和结果。
4. 原生问题选择 Markdown，得到 native tool/result，待决卡消失。
5. 对 `hold` 会话 Stop，收到确认且 Session 标为已停止。
6. reload 后恢复相同原生消息 ID、角色和正文，无重复或已过期审批。
7. 只对该 fixture 拥有的 dsh PID 执行 SIGKILL，EventSource 重连，历史一致，新 echo 可继续执行且只有一份回答。
8. 清除该浏览器的旧 onboarding 标记，直接打开 `?onboarding=1#personbot`，可使用原生入口且没有旧引擎 onboarding 弹窗。
9. 在 1440/768/390 宽度截图；页面无横向溢出，输入与按钮在屏幕内。手机标题避开全局导航按钮；处于跟随状态时改变视口仍保持最新消息可见。
10. 浏览器 console 无 error；关闭 fixture 后新启动的 dsh child 也退出，临时 home 已删除。

主要证据已保存在仓库中：[验证数据](evidence/personbot-app-2026-11-05/evidence.json)、[桌面截图](evidence/personbot-app-2026-11-05/personbot-1440.png)、[平板截图](evidence/personbot-app-2026-11-05/personbot-768.png)、[手机截图](evidence/personbot-app-2026-11-05/personbot-390.png)与[审批截图](evidence/personbot-app-2026-11-05/approval-pending.png)。

原始日志和证据目录：

```text
/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/
  server-1793868479726-89376.log
  server-1793868479726-89376.log.personbot/
    evidence.json
    approval-pending.png
    personbot-1440.png
    personbot-768.png
    personbot-390.png
```

测试只使用临时 server、隔离 Chrome profile、真实 dsh 进程、假模型与受控工具。未访问用户正在运行的 App、个人 dsh profile、真实账号或外部模型服务。浏览器工作流通过不能解释为真实模型质量或远程部署验收。

## 当前边界与后续

- 原生委派子 Agent 使用 `approval: never`，且仍由活动父 Agent 拥有时不能直接向用户提问。独立根 Session 和 task-bound worker 支持交互；DTO 的 rootSessionId 不解除原生限制。
- 附件仅显示已记录引用，下载、预览、产物 ID 和产物存储属于 W4。
- Task/Execution 目前仍是协议类型和 Session 绑定。Super Agent 监督、Effects/Outbox、业务验收、长期记忆、主动触发尚未实施；原生 turn 完成不代表业务任务完成。
- App/CLI 默认共享 `~/.personbot`，排他锁禁止同时拥有同一 home。旧 App 备份不包含这个默认目录，也不协调运行中的 personbot 数据。
- 当前为源码运行交付；dsh 制品的桌面打包、Linux 专项验证、Windows 支持及真实 provider smoke test 尚待完成。

下一阶段 W3 将实现持久业务任务与执行状态、独立 worker、持久动作和结果回传，再整合 Super Agent 监督核心。
