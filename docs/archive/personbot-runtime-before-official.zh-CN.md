# personbot：dsh 原生执行底座

本文对应 2026-11-05 至 2026-11-06 实施的 W0–W6。个人源码 App 默认直接进入 Personbot，执行链为：App → 现有鉴权 → Personbot gateway → 自有进程 Host → `personbot.v1.*` 协议插件 → 业务监督层及 dsh 原生 Agent、工具和 Session。终端客户端继续使用同一个协议。日常启动和界面操作见 [产品使用说明](personbot-product.zh-CN.md)。

Personbot 直接使用 dsh 原生循环。App 已接入会话创建和切换、流式聊天、工具轨迹、审批、提问、Stop、重连恢复、持久长期任务，以及项目、角色、确认后的长期记忆、不可变产物、事件订阅、定时触发和通用 Webhook 渠道。自有监督层提取 Super Agent 的领域事务、Effects 和 Outbox 机制，通过原生独立 worker 执行；它不再实现模型工具循环。W6 提供独立主工作台、写入式模型设置、确认后的旧历史导入和旧执行入口切换，旧界面可显式回退。

## 在 App 中使用

当前入口面向个人源码安装：

```sh
pnpm install --frozen-lockfile
pnpm personbot:start
```

启动器自动按需构建界面，从默认 `http://127.0.0.1:8799` 提供前后端。首次进入 **模型设置** 保存 key 后创建会话；也可以预先在服务端环境设置 `DEEPSEEK_API_KEY`。`pnpm personbot:start --demo` 提供不需要 key 的临时确定性演示。手机从左上角按钮展开导航。所有接口继续使用 App 原有登录和权限检查，远程部署继续遵守服务端鉴权。

默认使用 `deepseek-official / deepseek-flash`；模型设置还提供锁定发布包中的 `deepseek-v4-pro`。API key 只写入，不读回；环境值优先。运行时已启动时，更改生效配置会要求显式重启。首次安装在已配置凭据的 Personbot 视图连接时启动 dsh；已有集成数据库会在服务启动时恢复运行时，供定时事件和待回传结果继续推进。查看 status 本身不会启动进程。App 暂不提供 provider 或运行时插件安装。

| 服务端变量 | 默认值与用途 |
|---|---|
| `PERSONBOT_ENABLED` | 个人源码服务默认启用；`0` 关闭。打包版和 hosted workspace 默认关闭，显式 `1` 才启用 |
| `PERSONBOT_PRIMARY` | 个人源码默认主模式；`0` 显式回退旧界面和执行路径；hosted/Cloud 不自动进入主模式 |
| `PERSONBOT_HOME` | `~/.personbot`；绑定、回执与原生 Session 的持久目录 |
| `PERSONBOT_WORKSPACE` | 所选 home 下的 `workspace`；新 Session 使用的工作目录 |
| `PERSONBOT_PROVIDER` | `deepseek-official`；选择 profile 已注册的 provider |
| `PERSONBOT_MODEL` | `deepseek-flash` |
| `DEEPSEEK_API_KEY` | 环境值优先交给原生凭据服务；没有环境值时可在 App 写入式保存 |

App 和 CLI 默认共享 `~/.personbot`，同一个 home 的排他锁只允许一个运行时。两者不能同时占用该 home；需要并行使用时，显式指定不同的 `PERSONBOT_HOME` 或 CLI `--home`。Session 创建后工作目录保持绑定，不随新的环境设置悄悄改变。

Personbot home 默认位于旧 App `OMB_DATA_DIR` 之外。旧 App 的备份不包含这份原生状态；需要备份时，先停止 Personbot 所属服务，再单独保存完整 home。将 home 手动移入旧数据目录，也不会让旧备份/恢复机制获得运行时协调能力，当前不支持这种运行中备份组合。dsh 制品的桌面打包和跨平台发行尚未验收。

## 运行入口

在仓库根目录执行。仓库要求 Node.js 24 及以上，本阶段验证环境为 Node.js 26.10.0、pnpm 10.33.0、macOS。当前运行时的内核锁依赖只面向 macOS/Linux；Linux 尚需独立验收，Windows 暂不属于支持范围。

```sh
pnpm install --frozen-lockfile
pnpm personbot --demo
```

`--demo` 启动真实 dsh 子进程，加载确定性假模型，不调用外部模型 API。默认创建临时 HOME、DSH_HOME 和工作区，正常退出时删除这些临时目录。以下输入可以直接体验消息、审批、提问和停止：

```text
echo hello
approve
question
hold
/stop
/sessions
/quit
```

- `echo hello`：原生模型管线返回 `hello`。
- `approve`：原生工具请求审批；按终端显示的 `/approve REQUEST_ID` 或 `/deny REQUEST_ID` 操作。批准后才在临时工作区写入 `approved.txt`。
- `question`：原生 `ask_user_question` 提问。终端显示请求 ID 后，可以输入 `/answer REQUEST_ID {"answers":[{"id":"format","selected":["Markdown"]}]}`。
- `hold`：模型调用保持等待，便于验证 `/stop`。`/stop` 停止当前 Session 的执行树；`/quit` flush 并关闭整个运行时。
- `/sessions`：查看绑定与当前原生状态。终端使用一个主 Session，协议可创建多个并发 Session。

若希望保留演示数据以检查重启行为，显式指定独立目录：

```sh
pnpm personbot --demo \
  --home /tmp/personbot-demo-persistent \
  --workspace /tmp/personbot-demo-workspace \
  --session main
```

显式指定 `--home` 后，该目录不会自动删除。再次使用相同 home、workspace 和 Session ID，会恢复已有原生 Session；终端暂不重放完整历史文本。

## 接入真实 DeepSeek 模型

当前 profile 默认使用 `deepseek-official` provider 和 `deepseek-flash` 模型，与锁定版本的原生默认配置一致。已安装的 `@deepseek-ai/dsh-llm-deepseek-api-key` 源码中，凭据引用默认值为 `DEEPSEEK_API_KEY`，由 dsh 凭据服务解析，也支持启动环境中的同名变量。

在启动终端中设置 `DEEPSEEK_API_KEY` 后执行：

```sh
pnpm personbot \
  --home "$HOME/.personbot" \
  --workspace /absolute/path/to/your/project \
  --provider deepseek-official \
  --model deepseek-flash \
  --session main
```

也可通过 `PERSONBOT_PROVIDER` 和 `PERSONBOT_MODEL` 设置 provider、model 默认值。命令行参数优先。`--provider` 和 `--model` 选择已经由 profile 注册的路由，不会自动安装新的 provider 插件。

真实模型调用、网络和实际模型表现尚未纳入本阶段的自动验收；已验证的是实际 dsh 进程、Session 和工具管线与受控模型之间的行为。

## 在 App 中运行长期任务

进入 **长期任务**，点击 **新任务**。填写目标、逐行完成条件，以及 worker 所需的补充上下文，然后点击 **创建并执行任务**。也可直接在聊天中要求把工作交给后台任务，主 Agent 可调用 `personbot_task_create`；确定性演示模型支持 `task task-review`、`task task-hold` 等 fixture 指令。

每项任务绑定来源会话，并拥有固定的 `worker-<taskId>` 原生根 Session。任务执行、主聊天和其他 worker 相互独立；当前最多同时运行 4 个 worker 根，其余保持排队。查看任务会话可以读工具记录、处理独立根的原生审批或提问；**返回来源会话**后可继续聊天。worker 会话不提供普通消息、Session Stop 或自动 Session resume，防止绕过业务状态。

任务面板提供以下控制：

| 控制 | 行为 |
|---|---|
| 暂停任务 | 先保存暂停意图、撤销后续工作资格，再停止该任务的根、子 Agent 和后台进程 |
| 继续任务 | 显式分配新的 Execution，复用同一个 worker Session；可附加核对结果或继续说明 |
| 终止任务 | 持久关闭任务并停止执行树，之后不自动恢复 |
| 验收通过 | 仅对已提交证据且已确认停止的报告开放，将任务标记为完成 |
| 要求修改 | 将修改意见作为新的 Execution 输入，保留 worker 原有上下文 |
| 补充要求 | 活动任务中持久保存补充说明，以原生 steer 投递给同一个 worker 和 Execution；尚在排队时等待 worker 启动后投递 |
| 重试停止任务 | 停止结果未知时，用新的明确命令再次核对并停止；旧命令重试只回放旧回执 |

worker 使用 `personbot_task_report` 提交 `review`、`waiting_event`、`blocked` 或 `failed`。`review` 至少带一项证据，进入待验收；最终文本或原生 turn 结束都不会自动完成业务任务。报告会终结原生轮次，并持久排队停止其已有子 Agent 和后台进程；`stopState` 从 `pending` 变为 `confirmed` 后才开放验收、修改、恢复或定时继续。无法确认则保留 `unknown` 并要求明确处理。

worker 正常委派原生异步子 Agent 时，根 Agent 可以暂时空闲，等待子 Agent 的原生结果回传后继续同一个 Execution。监督层在任务锁外等待这段工作，因此暂停和终止仍可及时停止执行树。只有整棵原生树稳定空闲、仍没有有效报告时，才将任务设为受阻；已经提交终态报告的树则立即进入停止收尾。

`waiting_event` 期间不调用模型。指定 `wakeAt` 的等待由同一监督层计时，时间到达后创建一次新的 Execution；未指定时间则等待用户明确继续或已配置的外部事件订阅。计时器随运行时存在，服务停机期间不执行模型，重启后处理已经到期的等待。

任务报告、失败、暂停和完成等进展通过持久 Outbox 回到来源会话。通知有稳定 ID，与用户输入区分来源；界面立即展示任务报告和回传状态。来源会话正在执行时，通知保留在 Outbox 等待；来源会话空闲后，将通知持久注入原生 `next-step` 上下文，再确认回传收据。通知不主动唤醒主聊天模型；下次正常用户输入与这些进展在同一轮消费，不为每条通知另开模型轮次，原生历史中显示独立的任务通知。

运行时在已投递执行中崩溃时，该 Execution 记录为结果未知，任务受阻，不自动重复工具操作。这个规则也覆盖已经请求暂停/终止、尚未确认停止，以及已经报告、尚未完成 seal 的窗口；保留已提交报告和清理动作，但阻止定时继续与直接验收。已暂停、已终止的业务意图保留。点击继续前，应查看已有工具记录，核对副作用，并在说明中补充结果。尚未尝试的持久 dispatch effect 可以恢复；有投递回执却未确认完整执行结果的情况采用保守阻塞。崩溃前启动的 OS 后台进程可能在原运行时退出后继续存活，新运行时不能仅凭重建的执行树证明它们已停止。历史 Execution 的 `effectsUnknown` 会保留，即使任务随后已终止且当前树已确认停止，界面仍提示核对历史操作。任务和会话的上下文延续不等于外部写操作可以安全重做。

## 项目、角色、记忆和产物

在 **项目与记忆** 中管理项目、角色和记忆。新会话上方的项目与角色选择器决定绑定；默认使用 `default` 项目和 `assistant` 角色。已有会话显示固定绑定，项目源路径与角色说明版本会在创建时保存。修改配置用于之后的新会话，不会静默改变旧会话或它后续创建任务的项目源。角色目前是持久说明 preset，不切换模型路由、凭据或工具权限。

项目需要本机绝对目录路径；Git 类型要求仓库根目录。绑定项目的新任务使用 `<home>/workspaces/tasks/<taskId>`：

- 普通目录项目创建独立输出目录，原目录以 `sourcePath` 提供给 worker，不自动复制整个项目。
- Git 项目以当前 HEAD 建立 detached worktree，不复制来源目录尚未提交的修改。恢复同一任务时保留该 worktree 的修改和提交；不自动 reset、合并或删除。
- 已建立的目录或 manifest 丢失、绑定不匹配时明确报错，不能以空目录替换。旧的未绑定项目 Session 继续使用原 cwd。

工作目录隔离防止任务默认写入同一组文件，并不构成操作系统安全沙盒；原生工具仍遵守实际权限与授权范围。

记忆支持个人和项目两个范围。用户保存或纠正后立即成为有效版本；相同范围、项目和 key 的旧事实原子替代，历史版本仍保留。Agent 通过 `personbot_memory_propose` 生成的建议显示为 **等待确认**，用户点击 **确认记忆** 后才能进入后续检索。旧建议不能覆盖它提出之后发生的人工修正或遗忘。`personbot_memory_search` 只检索有效的个人记忆和当前项目记忆。

每次新输入把固定角色与当前有效记忆放在同一条原生用户消息的独立文本块中，输入的上下文快照先持久保存，再投递给 dsh，不另开模型轮次。重试和冷恢复使用同一快照；App 只把原始用户文本显示为用户消息。**忘记记忆** 停止后续检索，已经存在于原生日志或模型历史中的文本仍保留，因此不能承诺模型从旧对话中忘掉该事实。当前每次输入最多注入 40 条、约 64 KiB 记忆文本，更多内容可通过搜索工具读取。

**产物** 区域显示当前会话以及来自其任务的文件，可从该 Session 工作目录发布已有文件，也可由 Agent 使用 `personbot_artifact_publish` 发布。服务把 regular file 的字节复制进私有存储，并分配稳定 ID 和 SHA-256；后续修改或删除源文件不会改变已发布版本。单个文件上限 20 MiB，下载按最多 512 KiB 分块读取。发布拒绝越界路径、逃逸符号链接和非普通文件。

文本与 Markdown 以转义文本预览，安全的栅格图像可显示图片，其他文件可下载。HTML 与 SVG 不作为可执行页面内嵌。HTTP 下载经过现有 owner/admin 与会话有效性检查，不接受任意文件路径。worker 报告可附 `artifactIds`，运行时检查产物属于该 Task 的当前 Execution，并把稳定引用带回来源会话；内容是否满足完成条件仍由用户验收。

App 的 **补充要求** 入口把文字明确关联到已有任务，不根据主聊天语义猜测要修改哪项任务。活动任务复用同一 worker 和 Execution；暂停或待验收后使用 **继续任务** 或 **要求修改**，形成新的 Execution 并保留历史。若原执行在补充送达前已结束，说明仍保留在 Task 中，下一次明确恢复会一起交给 worker。

每个任务最多保存 100 条补充，创建和补充时任务记录的总字节预算为 1 MiB；超出时拒绝整次命令，不留下半条补充或投递动作。较大的材料应发布为产物后提供稳定引用。快照目前仍全量读取，此预算不等于已经实现大量历史任务的分页与归档。

## 代码与责任边界

| 位置 | 负责的内容 |
|---|---|
| `packages/personbot-protocol/src/index.ts` | 版本化命令、事件和输入校验；Conversation、Task、Execution、SessionBinding 类型 |
| `packages/personbot-runtime-host/src/index.ts` | 启动并拥有一个子进程、并发 RPC、超时、断连、有限 stderr 和退出升级 |
| `packages/personbot-runtime-plugin/src/launch.ts` | 生成专用 profile、检查已安装 dsh 版本、指定独立 DSH_HOME |
| `packages/personbot-runtime-plugin/src/index.ts` | 创建/恢复根 Session、消息投递、审批/提问、原生事件、快照、执行树停止 |
| `packages/personbot-runtime-plugin/src/tasks.ts` | 原生任务工具、独立 worker 分配、并发名额、报告终结、执行树收尾和 Effects dispatcher |
| `packages/personbot-supervisor/src/store.ts` | Task/Execution、命令回执、完成验收、持久 Effects/Outbox、等待和恢复状态 |
| `packages/personbot-personal/src/` | 项目、角色、记忆及版本历史；任务目录和 Git worktree manifest |
| `packages/personbot-artifacts/src/` | 不可变字节副本、SHA-256、归属、稳定发布回执与分块读取 |
| `packages/personbot-integrations/src/` | 来源认证、持久事件去重、线程订阅、定时 Trigger 和外部回调 Outbox |
| `packages/personbot-runtime-plugin/src/personal.ts` | 个人能力原生工具、会话绑定、输入上下文和产物归属检查 |
| `packages/personbot-runtime-plugin/src/transport.ts` | 自有 NDJSON 服务端、完整请求校验、协议错误码、帧限制和输出 flush |
| `packages/personbot-runtime-plugin/src/store.ts` | SQLite Session 绑定、稳定输入身份、投递回执、Stop 命令回执 |
| `packages/personbot-runtime-plugin/src/lease.ts` | 同一个 home 的单运行时内核锁 |
| `packages/personbot-gateway/src/index.ts` | 启动和拥有 runtime、App RPC 白名单、独立来源 ingress、状态与通知转发 |
| `server/routes/personbot.ts` | 经现有认证的 HTTP/SSE 入口、独立来源 Bearer 认证的 Webhook、请求校验和连接清理 |
| `server/personbot-settings.ts`、`server/routes/personbot-setup.ts` | 写入式凭据、配置 revision/命令回执、活动配置和重启要求 |
| `server/personbot-legacy.ts`、`server/routes/personbot-legacy.ts` | 旧记录分页读取、冻结导入计划、同身份恢复和可选安全配置迁移 |
| `server/personbot-mode.ts` | 主模式选择与旧执行写入拒绝规则 |
| `server/index.ts` | 注册独立来源 ingress；服务启动时恢复已有集成运行时，使定时和回调不依赖 App 连接 |
| `packages/personbot-projection/src/` | 浏览器安全的原生历史与临时流投影、native seq 去重和快照协调 |
| `src/lib/personbot-client.ts` | App 连接、分页恢复、稳定命令重试与当前 Session 选择 |
| `src/components/personbot/` | 聊天、工具详情、审批、问题回答、长期任务、人工验收、个人设置与事件渠道管理 |
| `scripts/personbot.ts` | 终端客户端与演示入口 |
| `scripts/personbot-start.ts` | 按需构建、同端口源码 App 和隔离产品演示启动 |
| `upstream/personbot-runtime.lock.json` | dsh 包版本、研究源码引用和已提取的 Super Agent 机制范围 |

Task 拥有目标、完成条件和业务状态；Execution 记录每次实际安排及结果；SessionBinding 保持 Task 到同一个原生 worker 的映射。同一任务最多一个活动 Execution。数据库唯一约束、执行 ID、任务 revision 和稳定 effect ID 共同防止旧报告、旧停止回执或重复命令影响新执行。

专用 profile 组合 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-sdk-app`，关闭上游 stdio JSON-RPC 服务，由自己的协议插件独占这条 stdin/stdout。HMR、运行时插件管理工具、Cordis 管理工具、独立 schedule、原生 goal 工具/命令/自动续轮和 LLM 标题生成也已关闭，长期任务只有一个监督拥有者。日志走 stderr，stdout 用于协议。

## 数据、身份与恢复

运行时数据位于所选 `--home`：

```text
<home>/
  runtime/
    personbot.sqlite
    supervisor.sqlite
    personal.sqlite
    artifacts.sqlite
    integrations.sqlite
    legacy-imports.sqlite
    settings.json
    task-workspaces/<taskId>.json
    runtime.lock
  artifacts/blobs/<sha256>
  workspaces/tasks/<taskId>/
  dsh/
    profiles/personbot/
      package.json
      cordis.patch.yml
    ... dsh 原生持久化数据
```

SQLite 使用 WAL、FULL 同步，数据库文件权限为 `0600`。`personbot.sqlite` 拥有固定绑定、输入上下文、投递及 Session Stop 回执；`supervisor.sqlite` 拥有 Task、Execution、业务命令、Effects、报告和 Outbox；`personal.sqlite` 拥有项目、角色、记忆及修正历史；`artifacts.sqlite` 拥有产物归属和发布回执；`integrations.sqlite` 拥有来源、令牌哈希、订阅、定时、持久事件及外部回调回执。`legacy-imports.sqlite` 保存冻结导入计划与稳定会话身份；`settings.json` 保存写入式模型配置和有界命令回执，文件权限为 `0600`，父目录为 `0700`。原生模型历史、工具记录和 inbox 由 dsh 持久化。业务库与原生存储之间通过稳定输入身份和可恢复 effect 协作，不假设跨库原子提交。备份需要保存完整 home 和 Git 来源仓库；worktree 还引用来源仓库的 Git common directory，单独复制任务目录不是独立仓库备份。生成的 profile 会在启动时重新写入，暂不作为用户手动维护配置的入口。

每条消息有独立的 `commandId` 和 `messageId`，不依赖本次 RPC 的数字 ID。相同命令重试返回原回执；同一个 ID 携带不同内容会冲突。同一个 Session 不能同时绑定 Conversation 和 Task，也不能用已有 ID 悄悄改变绑定或工作目录。

输入投递区分以下状态：

1. `accepted`：业务库已保存输入，尚未确认原生持久入队。
2. `queued`：原生入队已经 flush，并保存业务回执。
3. 原生 `user/message`：输入已经进入原生会话历史。需要持久证据时，应读 flush 后的快照。

`queued` 不表示模型已经读到；模型读到也不表示工具工作或业务任务完成。Task 的持久完成状态由监督层的明确验收命令产生；尚无产品层 `input.read` 订阅服务或跨实体持久事件日志。

冷启动恢复会对照业务库中尚未取消的输入、原生历史和 inbox，使用原消息 ID 补回未进入历史的输入，再唤醒原生循环。这里专门覆盖了 dsh 已持久化“从 inbox 领取”，但尚未写入 `user/message` 就退出的窗口；不能仅检查 inbox 是否存在来判断输入已经处理完。

已经进入原生历史、但在模型调用或工具执行期间中断的轮次，不会通过重发原输入自动重做。主聊天可以提交新输入；任务由监督层保留未知执行结果并要求明确继续。新的任务 Execution 会提醒 worker 先检查已有副作用，不会重置会话或偷偷切换工具上下文。

一旦标记原生日志已成功建立，日志缺失时恢复会明确报错，不会以同名空 Session 替换上下文。恢复解决输入和上下文连续性；外部工具副作用没有通用的恰好一次保证，结果未知的写操作仍需核对。

同一个 home 使用原生 `flock` 排他锁。锁随进程死亡由内核释放；正常退出关闭持有的文件描述符，保留锁文件 inode，不通过删除锁文件来抢占。不同 home 可以拥有各自的运行时。

## 协议、事件与快照

协议采用一行一条 JSON-RPC 2.0 消息，当前版本为 1。请求在进入运行时前进行字段、文本长度、身份和分页校验，未知字段会被拒绝。

传输层限制单个输入帧最多 8 MiB，支持 UTF-8 字节分片和并发请求。错误码分别表示 JSON 解析失败（`-32700`）、无效请求（`-32600`）、未知方法（`-32601`）、参数错误（`-32602`）和业务执行错误（`-32000`）。参数校验错误不会统一变成内部错误。

| 方法 | 当前行为 |
|---|---|
| `personbot.v1.initialize` | 等待加载、验证模型路由，返回协议版本、generation、runtime manifest 和能力 |
| `personbot.v1.sessions.create` | 建立 Conversation 或 Task 到原生 Session 的绑定，已有匹配绑定可恢复 |
| `personbot.v1.sessions.resume` | 显式恢复已登记 Session |
| `personbot.v1.sessions.list` | 查看已有绑定、原生状态和未完成 Stop |
| `personbot.v1.messages.submit` | 使用稳定身份投递 `followup` 或 `steer` |
| `personbot.v1.sessions.stop` | 停止该根 Session 的执行树，返回确认状态和错误 |
| `personbot.v1.tasks.create` | 保存来源会话、目标、完成条件、显式上下文与稳定命令，排队独立 worker |
| `personbot.v1.tasks.list` | 读取持久 Task、Execution、Outbox 快照，可按来源 Session 过滤 |
| `personbot.v1.tasks.control` | 带稳定 commandId 和 expectedRevision 的 pause/resume/cancel/accept/revise/supplement |
| `personbot.v1.personal.snapshot` | 项目、角色和记忆快照 |
| `personbot.v1.projects.put` / `roles.put` | 稳定命令与 revision 校验的项目/角色保存 |
| `personbot.v1.memory.put` / `memory.control` | 人工保存、更正、确认建议和遗忘 |
| `personbot.v1.artifacts.list` / `artifacts.publish` / `artifacts.read` | 不可变产物的列表、发布与有界分块读取 |
| `personbot.v1.integrations.snapshot` | 来源、订阅、定时、事件与外部回调的有界快照 |
| `personbot.v1.sources.put` / `schedules.put` / `subscriptions.put` | 带稳定命令和 revision 校验的 owner 配置 |
| `personbot.v1.deliveries.control` | 人工确认未知回调已送达，或明确承担重复风险后重试 |
| `personbot.v1.approvals.resolve` | 对当前 generation 的指定原生工具请求批准一次或拒绝 |
| `personbot.v1.questions.answer` | 回答或取消原生提问 |
| `personbot.v1.snapshots.get` | 返回 Session 状态、待决请求，以及指定 Session 的已 flush 原生日志页 |
| `personbot.v1.shutdown` | 保留可恢复输入，flush 并关闭运行时 |

`followup` 对应下一轮输入，`steer` 对应下一步输入；它们使用 dsh 原生 inbox 语义。终端目前只提交 `followup`，协议两种模式均可使用。受监督管理的 worker 拒绝通过公开 Session create/resume/submit/stop 绕过任务状态；任务控制统一走 `tasks.*`。

运行时通过 `personbot.v1.event` 推送状态、流、原生事件、输入入队、审批和提问。`generation + eventSeq` 只标识本次进程运行期间的通知顺序，是临时游标；它不能作为跨重启的全局持久事件游标。转发的实时原生事件带有 `durable: false`，到达客户端不等于已经落盘。

指定 `sessionId` 的 `snapshots.get` 会 flush 活动 Session，然后通过异步原生日志接口读取。`fromSeq` 默认 0，`limit` 默认 128、允许 1–1000，返回 `nextSeq` 和 `hasMore`；单页也受约 4 MiB 的传输预算约束。客户端继续传入 `nextSeq` 读取后页。未指定 Session ID 时只返回状态及待决请求，不读取全部会话日志。

原生 seq 是每个 Session 各自的持久读取位置。App 通过 `/api/personbot/events` 接收临时 SSE 通知，在连接建立、重连、操作完成及周期检查时读取快照，并按 Session 补齐日志页。展示投影去重原生 seq，以已提交历史替换临时流内容；它不会重建或改写模型上下文。

当前 SSE 不保存通知重放日志，也不提供 Last-Event-ID 恢复。持久产品事件投影、跨 Session 全局事务游标和 `events.subscribe` 服务仍未实现。事件遗漏依靠原生快照修复，`generation` 变化会使旧审批和临时流失效。按服务端环境保存的当前 Session 选择仅是界面偏好。

Host 的超时和 AbortSignal 只结束本地等待。需要停止实际模型、子 Agent 和后台作业时，必须发送领域 Stop 命令。Host 关闭时先请求协议 shutdown，再按期限对它拥有的确切子进程发送 SIGTERM/SIGKILL。

## 审批与停止的实际边界

独立根 Session，包括绑定 `taskId` 的 worker，接入同一套原生审批和提问。待决请求绑定运行时 generation；重启后旧请求失效，不能把旧批准用于新调用。回答提问时支持选择、自定义文本、原生 Skip 或显式取消。

锁定版本的 dsh 对原生委派子 Agent 强制使用 `approval: never`。子 Agent 请求需要审批的写入时，会被原生策略直接拒绝，不会出现等待用户批准的卡片。该版本也禁止仍由另一个活动 Agent 拥有的子 Agent 直接向用户提问，要求它把未解决的问题放入最终结果，交回父 Agent 处理。本阶段保留这些原生边界；独立 worker 根 Session 支持审批和提问，不能据此声称原生委派子 Agent 同样支持人机交互。待决 DTO 中的 `rootSessionId` 为归属与后续整合保留，不解除原生限制。

Stop 先持久登记命令并取消该 Session 的未完成业务投递，随后取消拥有的根/子 Agent、待决请求和后台作业，等待 idle、flush 并释放原生根 Agent。其他根 Session 继续运行。Stop 返回 `confirmed` 与 `errors`，重复旧 Stop 命令返回原结果，不会终止之后的新执行。

停止后可以继续向同一个持久 Session 提交新消息。之所以释放后再恢复，是因为该版本 dsh 的子 Agent drain 会在原根 Agent 存活期间关闭其子 Agent 接纳。

显式 Session Stop 会撤销未完成用户输入的自动恢复资格，但保留待消费的监督通知；正常 shutdown 保留可恢复输入。Task 的暂停、继续和终止由独立业务命令处理，Session resume 不能代替任务恢复。

`confirmed: true` 表示本地所拥有执行树的停止获得确认，不撤回已经完成的文件写入或外部操作，也不证明远端副作用被回滚。

## 版本与验证

实际加载的 npm 包固定为 `@deepseek-ai/dsh@0.2.2-rc.1`，依赖解析由 `pnpm-lock.yaml` 固定。`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 是设计研究使用的源码引用，握手中称为 `sourceReference`；没有将它认定为已安装 npm 制品的可证明构建提交。

研究源码与同版本发布包存在 API 差异。实现以实际安装包的公开 API、类型和运行验证为准，不按源码引用推断发布包拥有全部同名能力。已从 Super Agent 引用 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` 提取领域事务、持久动作、稳定 Outbox 和 worker 报告设计；未加载其旧版 bundle、GitHub 单仓部署或 Web 面板。[来源与 MIT 许可](../packages/personbot-supervisor/THIRD_PARTY.md)记录具体机制及改造边界。

运行验证：

```sh
pnpm personbot:typecheck
pnpm exec oxlint --deny-warnings packages/personbot-* scripts/personbot.ts
pnpm personbot:test
```

测试包含协议校验、SQLite 命令幂等和 Host 子进程测试，以及使用真实 dsh 的隔离集成测试。原生集成测试使用临时 HOME/DSH_HOME、独立工作区、确定性模型和受控真实工具进程，覆盖：

- 两条并发 Session 的上下文与停止隔离。
- 根 worker 的审批、拒绝、实际写入、原生提问和过期 generation。
- 稳定输入身份、重启恢复、领取后未写历史的崩溃窗口，以及队列顺序。
- 旧 Stop 重试、新执行不受影响、未完成 Stop 对投递的阻断。
- 原生子 Agent 与真实后台 Node 进程的停止，包括实际 PID 退出。
- 已使用的原生日志缺失时拒绝替换，以及跨进程锁竞争与崩溃后重新获得锁。

App 的隔离验证：

```sh
pnpm exec vitest run \
  src/lib/personbot-client.test.ts \
  server/routes/personbot.test.ts \
  scripts/control-omb.test.ts \
  scripts/testing/personbot-ui.e2e.test.ts \
  scripts/testing/personbot-tasks-ui.e2e.test.ts \
  scripts/testing/personbot-personal-ui.e2e.test.ts \
  scripts/testing/personbot-events-ui.e2e.test.ts \
  scripts/testing/personbot-background.test.ts
```

真实浏览器测试复用现有 fixture launcher 和真实 `<App />`，使用独立 HOME/DSH_HOME、确定性模型和受控写文件工具。没有缓存浏览器时可显式设置 `OMB_UI_E2E=1`，由现有工具安装器获取固定版本。普通旧 fixture 显式禁用 Personbot；只有 `launchVerificationServer()` 的 `personbotFixture` 参数为布尔 `true` 时才能启用固定假模型，主模式还需要额外的 `personbotPrimaryFixture=true`，不透传个人 provider 或 key。

这些测试不使用用户正在运行的 App、个人 dsh profile、真实账号或真实模型。验证规则继续遵守[原有说明](verification/README.md)。W0/W1 的历史结果保存在[底座验收记录](verification/personbot-runtime-2026-11-05.md)；W2 App、gateway、投影和浏览器证据见 [App 验收记录](verification/personbot-app-2026-11-05.md)，W3 的任务流程与截图见[长期任务 App 验收记录](verification/personbot-tasks-2026-11-05.md)，W4 的完整结果见[个人能力验收记录](verification/personbot-personal-2026-11-05.md)，W5 的事件、定时与外部回传结果见[事件与渠道验收记录](verification/personbot-events-2026-11-05.md)。

本阶段任务证据是 worker 提交的文字/产物引用，由人对照完成条件验收；尚未自动证明测试通过或文件内容满足要求。任务快照当前全量读取，未完成分页与大规模任务归档。通用外部来源、跨重启的线程订阅和外部回调已实现，幂等回传需接收方遵守幂等契约；全局产品事件重放日志和自动评估器仍未实现。

原生历史中的旧附件仍以已记录引用显示；独立产物服务只管理显式发布的字节副本。角色 preset 不提供独立权限或 provider，目录隔离不提供 OS 沙盒，记忆遗忘不改写历史。W6 的主界面、设置、旧历史导入和执行切换见 [产品验收记录](verification/personbot-product-2026-11-06.md)；旧引擎私有状态、权限和自动化不迁移。

## 事件、订阅、定时与外部结果回传

在 Personbot 页面的 **事件与渠道** 中创建来源。先选择一个主会话，固定新任务的目标和验收标准，生成并复制来源令牌，再显式启用。令牌仅在生成时显示；服务端保存 SHA-256，快照、命令回执和事件正文不携带令牌。编辑来源可轮换令牌，来源会话绑定保持不变。此入口不要求把外部服务适配成另一套 Agent：业务事件始终进入相同的 Task 监督层与 dsh worker。

首个外部 Source 是通用 Webhook。发送方使用独立的来源 Bearer，向界面显示的地址提交以下 JSON：

```sh
curl --request POST \
  "http://127.0.0.1:2737/api/personbot/sources/SOURCE_ID/events" \
  --header "Authorization: Bearer ${PERSONBOT_SOURCE_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"eventId":"build-412","threadId":"project-builds","text":"构建结果及待检查材料"}'
```

端口和 SOURCE_ID 以界面提供的实际地址为准。这里只接受 `eventId`、`threadId` 和 `text`；不能提交任务目标、权限、taskId、审批结果或回调地址。外部正文明确作为不可信材料进入原生上下文，不能扩大预先配置的任务范围。此通用接入尚不是 GitHub、飞书或 Slack 的专用验签协议；这些服务后续可通过小型适配器映射稳定事件和线程身份。

HTTP `202` 表示事件已持久接受，不表示任务已经完成。相同来源及事件 ID、相同正文重试返回原接受回执；同 ID 改变线程或正文会冲突，不能重新派工。Webhook 与定时器使用不同的去重命名空间。界面从快照读取事件当前状态，重试返回的原回执保留最初的接受状态。

一个未绑定线程的首个事件会原子预留自动订阅和稳定 Task ID；同线程连续到达的事件回到同一任务。可以在“任务订阅”中把多个来源线程关联到一个现有任务，也可将一个线程关联到同会话的多个任务并扇出。来源、线程和 Task 绑定创建后固定，可启用或停用；需要其他关联时创建新订阅。已关闭任务不会因新事件另起任务，取消或完成后的事件标记为忽略。

- 活动任务：保存事件补充和投递动作，通过原生 steer 送入同一 worker 和 Execution。
- `waiting_event`：等待原执行树确认停止，再以事件继续同 Task、同 worker 的新 Execution。
- 暂停、受阻、失败、待验收：事件保持待处理，只有相应的用户继续或修改操作才能推进。
- 禁用来源或订阅：暂停相应待交付事件；已有执行的停止仍使用任务暂停或终止。恢复后继续原事件，不另造身份。

“定时触发”支持本地时间输入转换成带时区的绝对时间，以及至少 1 分钟的固定重复间隔。它们由现有监督计时器产生持久 Trigger，不会开启另一套调度或模型循环。一次性触发成功入库后关闭；停机错过多个周期时只产生最近一个到期事件，下一次触发推进到未来，避免恢复后集中补跑。等待与未来定时不调用模型。周期事件沿同一线程保持任务连续性；任务完成或终止后，后续周期事件忽略，不自动创建新的独立作业。当前不提供独立周期作业模板、cron、工作日规则或按时区夏令时保持墙上时间的周期。

配置过 Personbot 的服务在启动时恢复已有 `integrations.sqlite` 所属运行时，因此定时任务不依赖重新打开 App。服务器和 runtime 仍需运行；设备关机时不执行。原生运行时未能启动时会记录失败，App 重连或下一个 Webhook 可以重试启动。与 CLI 共用 home 的排他锁仍有效。

配置可选 HTTP 回调后，任务进展以持久 Outbox 回到所订阅的线程。JSON 包含 `deliveryId`、`sourceId`、`threadId`、`taskId`、`updateId`、`revision`、`text` 和 `createdAt`；接收方通过这些身份关联结果。每条投递的地址、模式和正文在入库时固定，后来修改配置不会改写已排队投递。禁用来源或订阅停止未来结果扇出，已入库回调仍按原投递生命周期推进；重新启用订阅不会补发禁用期间的历史报告。原生 App 通知与外部回调分别确认，互不覆盖回执；同来源线程的旧投递未解决时，后续投递保持排队。

| 回调模式 | 恢复和重试 |
|---|---|
| 接收方支持幂等键 | POST 携带稳定 `Idempotency-Key`。网络失败、非成功响应或发送中崩溃后复用同 ID、同正文重试，每轮最多 5 次并退避。实际副作用去重依赖接收方遵守幂等契约 |
| 不自动重试不明确的结果 | 请求失败或发送中断后保存 `uncertain`，重启不自动再次发送；在 App 核实后可确认已送达，或显式选择可能重复的重试 |

回调仅支持 HTTPS 或本机回环 HTTP，不跟随重定向，不读取无界响应体。当前没有提供供应商专属的回调签名或独立认证配置。`2xx` 只表示接收方确认收到，不能证明接收方之后的业务动作成功；不声称任意远端恰好一次。人工将未知投递标为送达只更新本地回执，不向远端另发消息。

配置最多 32 个来源、128 个定时配置、256 个订阅，事件正文最多 32 KiB。未解决事件队列最多 2048 条，满时原子拒绝新增；未解决外部回传最多 4096 条，满时保留尚未扇出的业务更新，已入库回调继续排空，腾出空间后再推进。快照最多展示 100 条事件和 100 条回传，并受约 7 MiB 字节预算约束；回传优先保留需要人工处理的旧回执，字节不足时先裁减事件和普通回传。完整记录仍在 SQLite，当前没有历史分页和自动归档。回调结果正文最多 32 KiB，并标记截断；完整报告和产物仍从 App 查看。

实现与隔离验证见 [W5 事件与渠道验收记录](verification/personbot-events-2026-11-05.md)。所有网络测试均使用本机模拟接收方，没有使用真实来源账号或外发消息。
