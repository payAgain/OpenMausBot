# personbot 原生运行时验收记录

日期：2026-11-05。分支：`personbot/dsh-foundation`。基础提交：`7117517bcfb6e4e688ba6bb02db8fda68e6fe828`。

环境：macOS arm64、Node.js 26.10.0、pnpm 10.33.0。实际加载 `@deepseek-ai/dsh@0.2.2-rc.1`。研究源码引用与 npm 制品的关系见 `upstream/personbot-runtime.lock.json`，没有验证两者构建提交相同。

## 自动验证

| 命令 | 结果 |
|---|---|
| `pnpm personbot:typecheck` | 通过 |
| `pnpm exec oxlint --deny-warnings packages/personbot-* scripts/personbot.ts` | 通过 |
| `pnpm personbot:test` | 45 项通过，0 失败；最后一轮约 13.7 秒 |
| `pnpm exec tsc -p tsconfig.server.json` | 通过 |
| `git diff --check` | 通过 |

45 项包含协议校验 5 项、Host 13 项、恢复回归 5 项、原生运行时集成 11 项、业务存储 4 项、自有传输层 7 项。

恢复与原生集成测试实际启动 dsh，使用确定性模型、受控工具、独立 HOME/DSH_HOME 和工作区。验证包括：

- 两条根 Session 并发，停止 A 后 B 仍在运行；旧 Stop 重试不会取消新执行。
- 审批批准前无文件，批准后实际写入；拒绝、过期审批和已结算请求不能写入。
- 原生提问选择、非法答案与 Skip；运行中 steer 在同一轮的下一步被读取，重复命令不会重复进入上下文。
- 原生历史保留、命令冲突拒绝、分页顺序与完整性、无效参数的实际 JSON-RPC 错误码。
- 在 inbox 已领取而 `user/message` 尚未提交的窗口强杀或正常关闭，恢复原输入与后续消息，保持顺序且各执行一次。
- 未完成 Stop 阻断旧输入重试；已建立的原生日志缺失时拒绝静默重建。
- 原生子 Agent 随根 Session 停止；后台 Bash/Node 作业的实际 PID 在停止后退出。
- 原生子 Agent 的 `approval: never` 拒绝交互审批写入。
- 跨进程内核锁排他；持有者被杀死后，其他进程重新获得同一 inode 上的锁。

原项目的相关回归命令：

```sh
pnpm exec vitest run \
  server/sessions.test.ts \
  server/runtime-coordinator.test.ts \
  server/runtime/runtime.test.ts \
  server/runtime/store.test.ts \
  server/runtime/scenarios.test.ts \
  server/drivers/native.test.ts
```

结果：285 项通过，0 失败。未执行整个桌面打包测试集合。

## 终端闭环

`pnpm personbot --help` 通过。另以仅继承 PATH/TMPDIR 的独立环境启动真实 `--demo` 子进程，依次验证：

1. 初始化并提交 `echo final-smoke`，收到原生回答。
2. 提交 `approve`，确认文件尚不存在，再使用实际请求 ID 批准；验证 `approved.txt` 的完整内容。
3. 提交 `question`，以 `selected: []` 回答，原生工具保留 Skip 结果。
4. 提交 `hold`，查询到 Session 为 `running`。
5. `/stop` 返回 `confirmed: true`；`/quit` 退出码 0，stderr 为空。
6. 确认该演示专属临时 home 已删除。

所有测试均未访问个人数据、运行中的 App、真实账号或外部模型 API。

## 基线限制

`pnpm typecheck` 的首个 `tsc -b` 步骤失败，共 28 条诊断：根 `tsconfig.json` 使用 ES2022 类型库，现有源码使用了 `findLast`、`findLastIndex`、`toReversed` 和 `Promise.withResolvers` 等较新 API。

已将未修改的基础提交导出到临时目录，使用同一套已安装依赖重新执行 `tsc -b`，得到相同的 28 条诊断；临时副本随后删除。这是基础提交中已有的问题。本次新增模块和原 server 的独立类型检查均通过。

本记录验收 W0/W1 执行底座。App/gateway、持久产品事件投影、Super Agent 监督层、业务 Task/Execution 状态机、长期记忆、产物和自动调度尚未接入。当前只在 macOS 验证；Linux 待验收，Windows 暂不支持。
