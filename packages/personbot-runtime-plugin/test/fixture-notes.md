# Deterministic native runtime fixture

Load `fixture-plugin.ts` as an additional owned `file://` Cordis plugin. It
registers provider `personbot-fixture`, model `fixture`, using the actual
`LlmAdapter` and native tool pipeline. No external model API is contacted.

Inputs:

| Text | Behavior |
|---|---|
| `echo TEXT` | Emits final assistant text `TEXT`. |
| `hold` | Keeps the real model call pending until its abort signal fires. |
| `approve` | Calls `personbot_fixture_write`, asking native approval before creating `approved.txt` in the session's explicit cwd. |
| `approve relative-file.txt` | Same, with a chosen file inside the workspace. Absolute paths inside the workspace are also accepted. |
| `approve {"path":"approved.txt","text":"expected bytes"}` | Same, with exact file bytes. |
| `question` | Calls the native blocking `ask_user_question` tool with question ID `format` and options `Markdown` and `Text`. |
| `child-approve` | Calls the native `subagent` tool with `approve child-approved.txt`. The native delegated-child policy rejects approval automatically, so no file is created. |
| `child-hold` | Calls the native `subagent` tool with `hold`. The parent can go idle while the child's model call remains pending. |
| `background` | Calls the native `bash` tool with `run_in_background: true`. A real Node process writes its PID to `background.pid` in the Session cwd and remains running until stopped. |

The fixture model finds the last message whose `role` is `user` and whose
`source.kind` is `user`, and reads that message's first text block; runtime
snapshots and the native subagent's appended return guidance are ignored. After a tool result it
emits the rendered result as the final assistant answer. Unknown input echoes
unchanged.

The write tool needs an explicit Session creation cwd, and that directory must
exist. It uses exclusive create (`wx`), follows no existing target symlink,
and checks both lexical and real parent containment before requesting approval.
Denied or unavailable approval returns `{path,written:false}` and creates no
file. Allowed approval returns `{path,written:true}`. The test harness should
use a fresh temporary workspace for each case.

For child tests, wait for an event with a different `sessionId` from the
parent. In the locked dsh `0.2.2-rc.1` profile, delegated children have native
approval policy `never`: `child-approve` reaches `ctx.approval.request` but is
rejected before the answerer waterfall. It must create no file and expose no
App approval. Supervisor worker approval is tested with an independent
task-bound root Session; it is a different case from native delegation.
With `child-hold`, wait until the child's `session.status` becomes `running`,
then stop the parent. The native child must become idle or be disposed, while
an unrelated root Session remains running.

For background tests, wait for `background.pid` and the native tool result
containing `started background job <id>`. Confirm `process.kill(pid, 0)`
succeeds, stop the root Session, and confirm the exact PID is gone. The model
does not call `job_output` or `job_kill` itself, so this proves the runtime's
stop path owns collection and termination. The command uses the current Node
binary and shell quoting for both arguments. No network access is required.

No new direct package dependencies were needed; the fixture uses existing
Cordis, dsh-llm, dsh-tools and dsh-user-approval dependencies.
