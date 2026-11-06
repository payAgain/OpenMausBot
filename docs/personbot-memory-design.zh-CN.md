# Personbot：原有记忆与官方 Super Agent 的边界

本方案保留 OpenMausBot 的原有记忆文件、搜索索引、变更记录、About me 和遗忘标记。官方 Super Agent 负责自己的任务、执行过程和 dsh 会话。两者通过一个受绑定约束的记忆端口协作；个人事实不另建一份 `personal.sqlite`。

实现入口是 `server/superagent-memory.ts` 的 `createSuperagentMemory`。它返回 `handle(request)`，供运行时网关调用。端口直接调用原有服务，因此原有 App 的记忆编辑页和 Super Agent 看到的是同一份文件。

## 数据归属

| 命名空间 | 内容 | 权威来源与存储 | 写入规则 |
| --- | --- | --- | --- |
| `omb.memory` | 明确保留的事实、偏好、项目笔记 | 原有 `workspaces/<botId>/MEMORY.md`、`memory/<topic>.md`、原有 archive | 原有记忆服务；保留来源与 journal |
| `omb.profile` | 用户跨 bot 的 About me、原有 learned facts | 每次调用时读取原有资料服务；原有 `profile-learned.json` 保留学习来源 | 沿用原有学习、移除和遗忘规则；端口提供受限读取、检索与 forget |
| `omb.conversation` | 旧聊天原文、bot 回答、对话摘要 | 原有消息 SQLite 与 FTS | 原有聊天服务；搜索结果属于历史上下文 |
| 官方任务上下文 | 需求、任务状态、worker 进展、交付与验证记录 | 官方 Super Agent 的领域仓库 | 官方运行时拥有；不复制为个人事实 |
| dsh 会话上下文 | 模型消息、工具调用、恢复点、压缩后的会话 | dsh 原生会话存储 | dsh 拥有 |

命名空间表示信息的来源和用途，不表示把所有内容合并进同一张表。bot 回答和 worker 进展可以是有用的项目上下文，但不会因为被检索到就自动变为用户的个人事实。

`MEMORY.md` 继续使用原有 200 行、24,000 字节的核心记忆容量规则。原有服务在必要时把条目移到 `memory/archive.md`；端口同时记录核心文件与 archive 的变化。主题文件使用原有文件大小限制、原子写入和敏感值遮盖。

## 端口及绑定

```ts
createSuperagentMemory({
  store,
  aboutMe?,
  readAboutMe?,
  canRead?,
  canWrite?,
  roomFeeds?,
}).handle({
  botId,
  threadId,
  contextId?,
  operation: "search" | "read" | "remember" | "forget",
  query?,
  path?,
  text?,
  evidence?: { messageId: string, quote: string },
  caller?: {
    requestId: string,
    sourceMessageId?: string,
    authorizationVersion: number,
    agentId: string,
    role: "master" | "worker" | "upkeep",
    ticketId?: string,
  },
});
```

`SuperagentMemoryStore` 是一个结构接口，要求 `bot`、`botByThread`、`taskByThread`、`activePath`，以及可选的 `groups`。原有 `Store` 可以直接传入；无需复制 bot 或聊天记录。导出的 bot、task、room、message 类型只要求端口使用的字段。

运行时网关从可信的会话能力解析 `botId/threadId/contextId`，并把原请求、原用户消息、授权版本和真实 Agent 身份一起传入。模型工具的参数不能自行指定这些身份或把 worker 升级为 master。网关验证持久请求和授权版本，记忆端口仍会重新读取当前状态并检查：

1. bot 仍然存在，且 `memoryEnabled !== false`。
2. thread 当前确实属于该 bot，或属于显式允许的 room。
3. `canRead` 没有因可见性、分支退出等原因拒绝访问。
4. 写操作的 `caller.role` 必须为 `master`，具有非空 request/Agent 身份和正整数授权版本；`sourceMessageId` 必须等于当前活动路径中最新、未取消的本人直接消息。peer、relay、aside、webhook 和 room 工作不能写个人事实。
5. `canWrite(binding, request)` 必须明确返回 `true`。宿主借此重新验证当前请求和授权版本；未配置这个回调时，读端口仍可使用，所有写操作都拒绝。

`canRead/canWrite` 只能收紧权限，不能越过端口自己的作者、调用者和证据检查。worker 默认只获得记忆读取工具，写入候选交给主助手；即使手工构造 worker 写 RPC，宿主和记忆端口仍会拒绝。传入 `roomFeeds` 才能允许 room 读取 bot 记忆；它应使用原有 audience 规则，确保这份记忆允许被回复的所有接收者看到。默认拒绝 room。room 的对话检索限于该 room 的主线程与任务线程，不会搜索 bot 的私人聊天。

端口保留入站 `contextId`，供宿主识别已经退出的分支。`canRead(binding, purpose)` 的第二个参数区分 `"request"` 和 `"recall"`：入站请求应检查活动原生分支，历史候选则没有活动 `contextId`，应检查其普通可见性。两种检查都不能放宽 audience 边界。只有一个参数的既有回调也可使用，但不应把“候选历史线程没有原生活动上下文”误判成“所有聊天历史都不可检索”。

此接口默认面向当前的个人本地产品。多用户 Team Cloud 不能仅凭 room 成员关系获得读取许可；必须继续使用原有 audience/layer 策略。该端口没有把个人资料层静默合并为 bot 的公共层。

## 检索与读取

`search` 使用原有 `searchMemoryFiles`、`recallMessages` 和可选的实时 `readAboutMe(binding)`：

- 记忆文件按原有 FTS 索引检索。索引在搜索时与磁盘同步。每天的 `memory/log` 是历史记录，不作为 `omb.memory/durable-note` 返回。
- 只有本人直接会话可以检索该 bot 的其他可见聊天。peer 或 relay 发起的工作不获得整个私人聊天历史。
- 原有 FTS 命中还必须位于对应线程的当前活动路径；保留在数据库里的已退出分支不会重新进入上下文。
- room 只有显式授权后才能检索，且只检索该 room 的范围。
- 结果分别标记 `omb.memory/durable-note`、`omb.profile/owner-profile` 和 `omb.conversation/historical-context`。资料命中带原有 `About me` 来源、原始行号及当前内容 hash；笔记与对话带文件或消息 ID、时间；对话结果保留 role、peer 等来源字段。
- 只有最新消息属于本人直接请求的私人会话才能检索个人资料。每次从原有服务重新读取，最多取两条相关资料行，并使用原有查询词、匹配数量门槛与遗忘标记过滤；room、peer、relay、webhook 和取消的请求不会触发资料回调。
- 遗忘判断使用原始来源：对话命中重新取得当前活动路径中的完整消息；笔记命中读取当前原始笔记文件。FTS 的 `[命中词]` 高亮与省略号只负责呈现，不能作为遗忘匹配的依据，否则多词短语会被高亮标记切断。笔记文件仍含已遗忘内容时，保守地排除该文件的命中。不会通过删除来源中的真实方括号来扩大原有 passage matcher 的语义。最多返回 8 项，片段合计最多 6,000 字符，每项最多 900 字符；查询最多 500 字符。

这是一种按原有关键词索引检索的实现，没有新增向量库或 embedding 服务。对中文、同义改写等情况的召回能力取决于现有 FTS tokenizer 和查询内容，不能把它描述为语义向量检索。

官方任务上下文通过官方运行时自己的任务读取、来源搜索和会话工具取得。模型可以在同一轮结合这些结果，但必须保留其不同来源；本端口不把官方任务库包装成 `omb.memory`，也不维护任务报告的第二份事实副本。

`read` 的笔记路径只允许 `MEMORY.md` 和 `memory/<topic>.md`。沿用原有路径允许列表与真实路径检查，拒绝绝对路径、`..`、符号链接逃逸和任意工作目录读取。每天的 `memory/log` 属于历史记录，不通过这个事实读取接口直接打开。单次读取最多返回 12,000 字符，同时保留完整文件 hash、长度和截断标记。

另一个明确的资源名是 `path: "about-me"`。它不映射为文件路径，而是实时调用宿主传入的 `readAboutMe(binding)`，返回 `omb.profile/owner-profile`，并保留 `About me` 来源、hash、长度与截断标记。同样最多返回 12,000 字符；敏感值按原有规则遮盖，已遗忘的资料行会被过滤。资料修改后下一次调用立即可见，不会复制进 bot 笔记，也不会永久追加到模型的 system prompt。未配置回调时该资源显示不存在。此读取只向当前本人直接会话开放；即便 room 获准读取 bot 记忆，也不能读取个人资料。宿主负责选择正确的个人资料服务；当前个人本地产品读取本地 About me，Team Cloud 没有实现安全的按人查找时不能提供该回调。

检索片段和旧笔记都属于上下文，其中看似命令的句子不能获得工具调用权限。当前用户的更正优先于旧信息。

## 明确记住与事实证据

`remember` 使用原有 `updateMemory` 向核心笔记追加一条事实；指定主题文件时使用原有 `journalMemoryWrite`。它不接受整份文件覆盖。每条最多 1,000 字符、20 行，保留原有日期、chat/thread 来源与 journal 的 bot/thread 身份。

本人开启的一轮工作中，bot 也会看到工具与 worker 输出。仅检查“这轮最初由用户开启”不足以证明某条个人事实是用户说的。因此端口同时要求原有消息证据：

- `evidence.messageId` 必须指向当前活动路径中最新的本人直接文本消息。
- `evidence.quote` 必须确实在这条消息中作为陈述出现，使用原有 `statedInConversation` 规则验证；问题和假设句不会作为事实证据。
- 没有显式 evidence 时，以 `text` 本身作为引用，支持“记住 X”这类直接摘录。
- `text` 必须保留被引用的原陈述；比较只规范大小写、Unicode、空白和末尾句号，不接受改变事实或省略否定的任意改写。需要概括时，先请用户明确确认要保留的表述，再使用那条新消息。
- 返回值保留被引用的消息 ID、thread、quote、requestId 和授权版本，便于核查来源。

例如，用户说“Remember that I keep a green bicycle.”，可以直接记住 `I keep a green bicycle`，同时引用原句中相同的陈述。不能仅凭这句引用写入 `The person's bicycle is green` 或 `The person owns a sailboat`。单独来自 worker 的“用户有帆船”不能引用 worker 自己来证明。

引用存在只能证明来源中有这段文字，不能证明任意改写符合原意。因此这个写端口采用保守的原文摘录规则，不尝试用关键词重叠作为语义授权。运行时把记忆写工具限制在主助手需要保存事实的场景；项目进展和 worker 报告默认留在官方任务上下文。原有记忆整理继续由原有服务完成。

## 更正、遗忘与异步结果

原有 App 的文件编辑、冲突 hash、journal 和回退入口继续使用原有 API。新端口没有修改这些 API 的语义。对话中的显式更正可以先 `forget` 旧事实，再 `remember` 用户现在明确陈述的新事实；端口没有虚构一个不存在的原子“语义替换”操作。

`forget` 同样要求当前 master 请求和真实原消息证据，并先检查原用户是否明确要求遗忘这个准确的 passage。当前实现保守支持直接英文 `Forget X`、`Please forget about X`、`Remove X from your memory`，以及中文 `请忘记 X`、`请把 X 忘掉`、`不要再记住 X` 等形式。命令必须直接位于原消息开头，目标与工具参数相同；不能把“忘记 jasmine tea”缩成更宽的“tea”。无关的“请总结项目状态”、否定“不要忘记”、问题、假设、文档引用、代码/引用块和等待后续确认的指令不能授权删除。含糊或未覆盖的说法应让用户明确重述，不交给模型自行推断删除权限。

传入的 `evidence` 必须真实存在于同一条原用户消息；未显式传入时，端口使用这条已由 request/sourceMessageId 绑定的真实原消息作为遗忘证据。返回值保留原消息、原话、requestId 和授权版本。全部检查通过后，`forget` 才使用原有 passage matcher 和 `forgetInNotes`，从核心笔记、主题和 archive 删除匹配的事实；注入 `aboutMe` 时也调用原有资料遗忘服务。即使没有配置 About me 助手，也会保存原有 `rememberForgotten` 墓碑，阻止后续自动学习重新写回。端口记录所有受影响记忆文件的 journal。

墓碑先于删除写入。这样即便之后某个文件操作失败，进行中的自动提取也不能把该事实重新学习回来。整个本地写入过程没有在“检查权限、读取文件、更新文件”之间等待模型或网络；不会在等待期间保留一份旧文件然后覆盖当前版本。

原有 memory upkeep 在模型返回之后、提交笔记/资料之前继续检查 `isForgotten`；About me 的学习计划也会重新加载墓碑。用户删除期间已经发出的模型请求，其旧候选会在提交时被挡住。只有用户再次明确记住、并通过当前消息证据的有效写入完成后，端口才调用 `clearForgotten`。无效、越权或过长的 remember 不会清除墓碑。

原生分支退出后，宿主撤销对应上下文权限；请求停止后，该请求的授权版本失效。目录变化产生新上下文时，旧后台任务可保留其原目录，但不能因此取得新输入的记忆写权。证据必须来自该调用者绑定的原消息，也必须仍是当前最新的本人消息，因此旧轮次的 message ID 无法用于新一轮记忆写入。自动提取的来源检查、墓碑检查和运行时分支检查各自负责不同的过期来源。

这里的“遗忘”沿用原有产品的使用语义：不再作为有效事实被记住或召回。它不会删掉旧聊天原文、原有 journal 的变更前内容、每日日志，或官方任务与 dsh 会话历史。历史保留和数据彻底删除是另一项操作；不能把普通 forget 宣称为跨所有存储的物理清除。若显式打开这些历史来源，应清楚标明其历史身份，并遵守当前用户的遗忘要求。

## 验证

`server/superagent-memory.node-test.ts` 在导入服务之前设置临时 `OMB_DATA_DIR`，使用真实的原有 `Store`、消息 SQLite/FTS、workspace、journal、About me 与遗忘服务。测试不访问用户正在运行的 App，不需要模型密钥或外部服务。

```sh
node --test server/superagent-memory.node-test.ts
pnpm exec oxlint --deny-warnings server/superagent-memory.ts server/superagent-memory.node-test.ts
pnpm exec tsc -p tsconfig.server.json --pretty false
```

测试覆盖原有写入与索引、主题与自动归档的 journal、跨 bot/room/隐藏线程隔离、最新作者与撤权、原生分支身份传递、真实与伪造证据、遗忘及旧候选阻挡、路径/链接拒绝和输出限额。额外真实服务回归验证：没有显式宿主授权、worker/upkeep、伪造 request/source/Agent、过期版本不能写入；无关总结请求不能删除原记忆、资料或写入墓碑；中英文直接遗忘可执行，引用、否定、问题、假设、目标扩大和待确认指令均拒绝；任意改写及省略否定不能借用真实引用写入。资料测试还验证实时编辑立即可见、相关行检索与匹配门槛、私人资料不进入 room/委派请求、分支和禁用状态每次重查、遮盖与遗忘过滤，且没有写入第二份事实。官方运行时到原有 App 的完整交互仍应另外通过隔离产品 fixture 验证；端口单元测试不能替代整个产品的运行验证。
