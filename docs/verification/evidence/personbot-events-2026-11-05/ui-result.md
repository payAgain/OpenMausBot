# W5 UI / client delivery complete

当前范围完成。没有修改 server/routes/runtime/gateway/protocol/integrations 包；没有 commit/push。保留 W0–W4 全部已有工作。

## Implementation
- 新 `src/components/personbot/PersonbotIntegrations.tsx`（268行）：Personbot 的“事件与渠道”入口，来源 / 定时 / 订阅 / 最近事件 / 回调回执五项。
- Source 创建/编辑：固定来源会话、目标和验收标准、callback URL/mode、启用开关。新来源默认关闭；本地 crypto.getRandomValues 生成32字节令牌，仅本次显示。普通编辑不提交 token，轮换明确触发，已接受保存后清空。无令牌 localStorage，HTTP地址和只含 eventId/threadId/text 的JSON示例可复制。
- Schedule：单次或 >=1分钟固定间隔，本机 datetime-local 转 ISO，默认关闭；说明停机错过的多次触发合并。已有 source/thread 不变。
- Subscription：仅可选与来源绑定同一 origin 的 Task；新建后 source/thread/task 输入全部禁用，仅 enabled 可编辑，并明确说明绑定固定。
- Events：近100条由服务端有界快照提供；显示状态、内容、event/thread、错误及原生任务入口。
- Delivery：状态/尝试次数/下次重试/错误；uncertain/failed 才有显式控制。手动重试先展开可能重复的说明，再点确认；支持确认已经送达。
- Client：integrations snapshot 与 integrations.changed 刷新；四类 mutation 保持命令/记录ID和原 expectedRevision 供含糊响应重试。源令牌只留临时待重试 payload，command identity 使用 SHA256，state/storage/key 不含 raw token；dispose 清理。
- PersonbotView 按已有 tokens/布局接入，CSS 增加缩窄容器保护。

## Final checks
- Focused client + components **46/46 PASS**，包括新增6个client测试场景和8个DOM测试。
- `pnpm exec tsc --noEmit -p tsconfig.json` PASS。
- 修改的client/component/E2E focused oxlint PASS。
- `git diff --check` PASS。
- design-taste app source lint **0 FAIL / 4 WARN**：2个padStart用于真实hex token和本地日期格式；2个font-mono用于literal令牌和HTTP endpoint，均为规则允许的字面代码/日期用途。保留原App风格。
- 新真实隔离 browser **1/1 PASS**，18.2秒，8项完整检查，console 0 error；全部7张最终截图已人工查看。

## Real-browser coverage
1. 默认关闭来源；本地令牌生成、保存后不可读、不入storage/snapshot；故意丢失已接受的创建响应后保持source/command一致重试。
2. 正确Bearer Webhook创建真实dsh独立任务；重复同ID内容返回原receipt，Task/Execution仍各1；事件链接打开native worker。
3. 本机mock callback首次断开，状态uncertain；UI在风险确认前无第二次请求；确认后相同immutable payload重试成功。
4. UI新增alias线程订阅，外部event唤醒原waiting_event任务；同worker、新execution、仍open/awaiting_review，需人验收。
5. UI新增过去时刻one-shot，产生durable event及新native任务，执行后自动关闭/清nextRunAt。
6. Browser reload 恢复sources/subscriptions/schedules/triggers/deliveries/tasks，不重做任务。
7. 1440/768/390来源列表和定时表单全部控件横向边界通过，手机侧栏收起。
8. 独占runtime/browser/server/local callback都退出，fixture dataDir删除。

Native datetime-local 的通用agent-browser fill不支持Chrome分段控件；最终E2E使用真实可访问年份spinbutton + ArrowDown/Tab选择过去日期，断言显示值和实际ISO RPC参数。产品保留正常onChange，没有注入DOM事件，也没有通过RPC创建schedule。

## Evidence
Final raw evidence directory:
`/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793886463088-51828.log.personbot-events/`

Files: evidence.json, callback-uncertain-confirmation.png, personbot-events-{1440,768,390}.png, personbot-event-schedule-{1440,768,390}.png.
Server log: same directory parent `server-1793886463088-51828.log`.
No raw token in trace/evidence; failure snapshots explicitly mask generated token inputs before capture.

Root owns docs; please archive these8 files to chosen W5 evidence directory and link verification guide. I have not edited docs to avoid ownership collision.

## Limits / remaining owner checks
- Browser verifies page reload; actual native process crash/restart semantics are covered separately by root native tests, not claimed here.
- Fixed interval, no cron/timezone/DST scheduling claim. Generic Webhook/callback, no provider connector promise.
- Same App fixed composer/header remain; long settings forms scroll inside transcript, actions remain reachable by genuine pointer clicks at390.
- Existing W2–W4 recipes untouched; root/other agent should run their regression suites. UI agent has not rerun them during W5.

Repro: `OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/personbot-events-ui.e2e.test.ts`.
