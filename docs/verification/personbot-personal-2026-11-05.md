# Personbot 项目、角色、记忆与产物 App 验收

日期：2026-11-05。分支：`personbot/dsh-foundation`。本记录覆盖 W4 的原生运行链路、App 与产物内容 HTTP 路由；长期任务基础流程见 [W3 验收](personbot-tasks-2026-11-05.md)，原生聊天见 [W2 验收](personbot-app-2026-11-05.md)。

## 操作入口与绑定

Personbot 对话区的“个人设置”默认收起，展开后可管理项目、角色和记忆。项目保存目录或 Git 仓库根目录；角色保存说明及版本。顶部“新会话的项目与角色”用于之后建立的会话，当前会话显示已经固定的项目与角色版本，工作目录来自实际 Session。修改目录或角色不会悄悄替换现有会话的执行上下文。

记忆可以保存为个人范围或指定项目范围。人工保存与纠正立即生效，Agent 提议的记忆显示“等待确认”；确认后才会参与后续上下文。忘记的记忆不再参与后续召回。原生历史继续保留，记忆修正不删除历史消息。

“工作产物”可按当前会话、来源会话及其任务、当前任务筛选。用户可从普通会话的工作目录发布文件快照。文本和 Markdown 预览按转义后的原文显示，支持安全栅格图片预览；HTML、SVG 和其他类型只提供下载。图片使用临时对象 URL，关闭预览、切换会话及卸载时释放。产物下载通过同源鉴权路由取得发布时的不可变字节，不读取后来变化的源路径。

执行中的长期任务提供“补充任务说明”，内容通过监督层交给同一 worker。暂停或等待验收的任务仍使用原有的继续、修改流程。任务卡显示独立任务目录、项目来源和补充说明记录。

## 隔离与命令

```sh
pnpm exec vitest run \
  src/lib/personbot-client.test.ts \
  src/components/personbot/PersonbotTasks.test.ts \
  src/components/personbot/PersonbotArtifacts.test.ts \
  src/components/personbot/PersonbotView.test.ts \
  server/routes/personbot.test.ts

pnpm exec vitest run scripts/testing/personbot-personal-ui.e2e.test.ts
```

全部行为验证使用现有 fixture launcher 的程序化 Personbot 开关。App server、浏览器 profile、HOME、DSH_HOME、native workspace 都位于本次临时目录；模型为确定性的 `personbot-fixture / fixture`。没有访问 live App、个人配置、凭据或外部模型。

## 客户端、组件与 HTTP 路由

聚焦回归 **52/52 通过**。覆盖原生聊天与任务既有行为，以及个人与产物快照加载、新会话绑定后的稳定重试、记忆命令与版本的稳定重试、已接受发布与刷新失败的区分、`personal.changed` 后立即刷新、活动任务补充入口、固定任务目录展示、产物名称转义和预览类型限制。

产物 HTTP 路由通过 gateway 的 `artifacts.read` 分块读取，最大总量 20 MiB，每块最大 512 KiB，检查连续偏移、前进、EOF 与不可变元数据。在每次 await 后重新核对访问会话，包含第二块读取期间撤销权限的回归。客户端权限不足时不会进入 gateway。路由只接受 artifact ID，不接受任意文件系统路径。

默认响应为 `attachment`。安全栅格图和转义文本才允许 `inline=1`；文本响应统一为 `text/plain`，HTML/SVG 继续强制下载。所有内容设置 `nosniff`、`no-store` 与限制性的 CSP。

前端 TypeScript、相关 oxlint 和新增界面的样式源检查通过。样式继续采用 App 已有 tokens；本阶段没有重新设计导航或主题。

## 真实浏览器闭环

完整浏览器工作流 **1/1 通过**，记录八项完成检查：

1. 在 App 中创建项目，故意丢弃服务端已接受的响应；重试使用同一命令与项目标识，持久数据只有一个项目。随后创建角色，以选择的项目和角色建立原生会话，快照与界面显示相同的固定绑定。
2. 保存项目记忆 `FORMAT_ORIGINAL`，下一次原生 `context` 调用确实读取它与固定角色说明。通过 App 将记忆纠正为 `FORMAT_CORRECTED`，再调用时包含新值，不再注入旧值。
3. 原生 Agent 提议个人记忆后，UI 实时显示待确认项；确认前实际模型输入不包含该值。用户点击“确认记忆”后，下一次原生输入才读取它。
4. 在 fixture 工作目录准备受控 Markdown 和 PNG，由真实 UI 发布。Markdown 中的 script 标签作为原文显示，页面没有执行它；栅格图片通过对象 URL 成功解码，关闭预览后确认对应 URL 已释放。改写源 Markdown 后，由浏览器同源 HTTP 下载取得原始 71 字节及 attachment 头。
5. 创建 `task-supplement`，在原生问题等待时补充任务说明，再通过原生问题卡回答。报告包含该说明，worker Session 与 Execution 均保持不变。独立任务目录区别于项目目录，来源路径与绑定项目相同。
6. reload 后，记忆、产物、任务说明和固定 Session 绑定恢复；下一次原生输入继续读取修正值。
7. 在 1440、768、390 宽度检查项目设置、产物操作、任务控件与主输入框均在视口内；浏览器 console error 为 0。人工查看三种尺寸与记忆、产物预览截图。
8. 关闭精确 owned runtime、浏览器、预览及 server，确认临时数据目录已经删除。

仓库证据：[完整数据](evidence/personbot-personal-2026-11-05/evidence.json)、[记忆确认](evidence/personbot-personal-2026-11-05/memory-confirmed.png)、[产物预览](evidence/personbot-personal-2026-11-05/artifact-preview.png)、[桌面](evidence/personbot-personal-2026-11-05/personbot-personal-1440.png)、[平板](evidence/personbot-personal-2026-11-05/personbot-personal-768.png)、[手机](evidence/personbot-personal-2026-11-05/personbot-personal-390.png)。六份归档文件与原始文件的 SHA-256 一致。

原始证据及 server 日志：

```text
/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/
  server-1793882709390-35272.log
  server-1793882709390-35272.log.personbot-personal/
```

## 原生运行与持久化验证

`pnpm personbot:test` 最终 **155/155 通过**。新增个人状态与工作目录包有 13 项测试，产物包有 12 项测试，另有两项完整原生 W4 工作流；同时回归已有协议、Host、gateway、投影、原生会话与长期任务。

第一项原生工作流证明固定角色和当前有效记忆确实进入确定性模型的实际输入，其他项目记忆不进入该会话。角色修改只影响新会话；Agent 提议必须确认；更正、遗忘与原生进程重启后的输入读取一致。相同输入命令重试只留下一个原生用户消息，App 投影保留用户原文。输入接受与冻结上下文在同一个事务提交；冻结失败时整次接受回滚，不占用命令或消息身份。旧 version 4 运行库升级后保留原绑定和输入。

第二项原生工作流建立真实临时 Git 仓库，保留来源目录的已跟踪修改及未跟踪草稿，再启动两个独立 worker。两个 worktree 内容来自已提交版本，互不相同且不修改来源目录；原生审批批准后才写入受控文件。真实产物工具发布文件，结构化报告携带正确的 Task、Execution、来源会话和项目归属。修改、删除源文件并重启 runtime 后仍能读到原始产物字节。原生提问等待期间的补充要求进入同一 worker 和 Execution，且只投递一次，重启后仍保留。

包级测试还覆盖过时记忆提议不能覆盖人工更正、版本历史和作用域隔离；两个工作树在新 Node 进程中重新打开后保留修改/提交；已建立目录或 manifest 缺失时明确失败；文件越界、逃逸符号链接、目录和 FIFO 拒绝；20 MiB 上限、分块读取、损坏或缺失 blob 报错。

审查新增的回归覆盖排队补充不同时出现在首次任务上下文和 steer 中、补充要求跨 Execution 的归属和重放，以及一次报告包含 40 条文字证据加 40 个产物引用。任务创建和补充受 1 MiB 记录预算约束，超限命令原子拒绝，避免合法补充累计超过协议帧大小。源码审查还确认，原生 child 的产物相对路径按实际 child cwd 解析，再受根工作目录包含检查；异步产物复制在提交前重验执行资格。这两个收尾分支未计入上述两项完整原生工作流的覆盖。

## 最终整体验证

| 检查 | 结果 |
|---|---|
| Personbot 包与实际原生运行 | 155/155 |
| client、组件、HTTP、导航、fixture、文档引用 | 95/95，8 个文件；其中聚焦个人能力/现有 UI 为 52/52 |
| W2/W3 既有浏览器流程与隔离检查 | 4/4，原 recipe 无需修改 |
| W4 完整浏览器工作流 | 1/1 |
| 前端、server、Personbot TypeScript | 通过 |
| focused oxlint | 通过 |
| `pnpm build` / `pnpm build:server` | 通过 |
| frozen lockfile 离线安装 | 通过 |
| `git diff --check` | 通过 |

构建仍有既有 CSS `highlight` 伪元素优化与大 chunk 警告。实际环境为 macOS arm64、Node.js 26.10.0、pnpm 10.33.0；dsh 固定为 `0.2.2-rc.1`，未升级底座。

完整命令、结果和证据文件摘要在[检查清单](evidence/personbot-personal-2026-11-05/checks.json)。原始输出：[包级及原生测试](evidence/personbot-personal-2026-11-05/native-tests.txt)、[客户端及路由等测试](evidence/personbot-personal-2026-11-05/client-routes-fixture-tests.txt)、[W2/W3 浏览器兼容](evidence/personbot-personal-2026-11-05/browser-compatibility-tests.txt)。[原生工作流说明](evidence/personbot-personal-2026-11-05/native-workflow-notes.md)区分具体覆盖范围。

## 边界

本浏览器验收验证确定性模型下的实际 App 交互与数据流，不评价真实模型的长期记忆质量或任务质量。独立 Git 工作树、重启恢复、记忆原子修正与过时提议冲突、原生任务产物归属等分支由各原生测试集验收，不计入上述浏览器覆盖。

浏览器验证下载路由返回的字节与 UI 链接，未验证操作系统下载管理器的最终保存位置。文本预览最多展示前 512 KiB，下载提供完整文件。工作目录隔离用于减少文件冲突，不等于操作系统安全沙箱；本阶段没有自动合并或清理工作树。
