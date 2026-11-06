# Super Agent source provenance and local changes

This package embeds the DeepSeek Harness team's `dsh-superagent` research
prototype source at commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`.
The original source is retained under `upstream/`, including its MIT
`LICENSE`, README, setup guide, prompts, skills, client, tests, examples and
original dependency lock. The original package metadata and original lock
are a record of that source release; the enclosing workspace lock controls
the dependencies actually installed here.

The prototype's README explicitly describes it as research code for
reference, **not an official DeepSeek product or production-ready
software**, and explains that the published implementation differs from
the article and the team's internal system. This adaptation retains that
qualification. The enclosing OpenMausBot project has its own license;
the vendored source retains its upstream MIT terms.

## Execution boundary

`src/plugin.ts` imports and constructs upstream `Runtime`. That Runtime
composes the upstream `Engine`, SQLite `Store`, `Sessions`,
`DshExecutor`, `Effects`, `Outbox`, policy and source registry. The
OpenMausBot source passes direct owner messages to `Runtime.receive`;
the official router tools select work, the official executor creates
persistent native DSH worker Sessions, and official reports and Outbox
deliver the result. There is no second model or task inference loop in
the gateway.

Node 26's native TypeScript loader strips types but rejects upstream
constructor parameter properties. Only managed child processes load
`src/runtime-loader.mjs`, which applies the pinned production Sucrase
TypeScript transform to this package's TypeScript files while preserving
imports and asset locations. Parent `src/index.ts`, `launch.ts` and
`rpc.ts` remain compatible with native strip-only loading. The two
compiler domains are checked separately.

The actual dependency set is pinned to DSH `0.2.2-rc.1`, Cordis
`4.1.0`, Schemastery `3.19.0`, proper-lockfile `4.1.2` and Sucrase
`3.35.1`. Upstream's original prototype targeted
`0.2.1-alpha.2`/Cordis `4.0.5-alpha.1`; the adaptations below describe
the compatibility changes.

## Patches to upstream source

- `src/deployment.ts`, `src/app/setup.ts`: add an explicit
  `localWorkspace` deployment. It skips mandatory GitHub identity,
  repository push-access and Git shim checks. The original GitHub
  deployment path remains available to upstream users of these classes.
- `src/executor/dsh.ts`: local execution uses the selected original Bot
  workspace, while retaining upstream ticket/assignment preparation and
  persistent worker identity. This initial product mode shares that
  workspace between its workers; it does not create a Git worktree for
  each task.
- `src/app/runtime.ts`: optional management-HTTP registration,
  permission-preset, prompt-suffix, additional-tool and committed-domain
  event extension hooks, plus an awaitable `beforeResume` hook. A durable
  original Stop intent ends restored tickets and persists task-source
  admission fences before native Sessions resume.
  OpenMausBot uses private process RPC and its
  original UI, so it disables the prototype's separate management
  listener. Core routing, task state, report, recovery and effect
  semantics remain upstream-owned.
- `src/app/sessions.ts`: honor the host's permissions for newly created
  and restored workers instead of unconditionally setting full access;
  append original Bot instructions inside the official complete router
  prompt; expose the host memory/history/question tools to the worker
  scope. Worker personal-memory tools are read-only; a candidate is relayed
  to the main Session without committing a fact. The fixture approval tool name is permitted but registered only
  in isolated fixture mode. Native question tools are enabled explicitly by
  the OpenMausBot host's `additionalWorkerToolNames`; upstream's default
  worker and descendant tool restrictions continue to deny direct questions.
- `src/executor/dsh.ts`: expose a read-only `workspaceBusy` query covering
  the existing worker, descendant agents, shell jobs and stop queue.
  The host adapter retains its shared-workspace execution lease until this
  native execution window is quiet; routing and task supervision remain
  upstream-owned.
- `src/core/ports.ts`, `src/core/replies.ts`, `src/app/store.ts`: preserve optional
  `answer`/`result`/`attention` purpose on outbound messages. Upstream
  otherwise collapses them into `kind: reply`; OpenMausBot needs the
  purpose to persist background results and handle clarification without
  losing the final result. A withdrawn receipt recreated after an
  in-flight delivery retains the same optional purpose. OpenMausBot
  receipts also retain the consumed `sourceTriggerId` at enqueue time, so
  later task input cannot change a queued reply's original authorization
  before its first delivery or during retries.
- `src/core/replies.ts`: inferred answer ownership also requires an actual
  ticket trigger input still present in its fan-out disposition, or the
  accepted origin of a still-live ticket.
  The accepted origin retains worker ownership before its initial
  assignment creates the first input. Thread subscriptions survive a human Stop, while
  Intake deliberately excludes that stopped ticket from later inputs;
  subscription reach alone incorrectly blocks later ordinary conversation
  with `noAnswer`. A focused original engine regression covers that case.
- `src/core/evals.ts`, `src/core/tickets.ts`: recheck current source scope
  before evaluating, routing or attaching an already recorded trigger.
  Intake filtering alone cannot revoke a stopped request that is already
  in the persistent main Session candidate queue. Revoked members of a
  held evaluation are removed with a committed refusal, while remaining
  inputs are requeued. This prevents a stale model routing call from
  creating another task after Stop. Engine regressions cover pending,
  held, replayed and attached triggers.
- `src/core/tickets.ts`: an explicit human Stop also withdraws the
  resumable mandate of an executor-completed ticket. Its recorded reports
  remain intact, queued inputs pass through the existing `letGo` rules,
  and a repeated human Stop stays idempotent. Stopping only open tickets
  otherwise leaves completed subscriptions able to claim future input.
- `src/app/resources.ts`: replace unavailable rc.1
  `sessionController.inspect` with native Session persistence
  `flush/open/read`, keeping paged transcript reads and tool-resource
  behavior.
- `src/app/http.ts`: handle the current optional Web server port type.
  The management HTTP server remains disabled in OpenMausBot mode.
- `src/app/runtime.ts`, `src/app/sessions.ts`,
  `src/client/prompt-config.ts`, `src/sources/github-trigger.ts`:
  minimal equivalent changes for the enclosing repository's lint rules
  (lexical accessor functions, direct Map-key iteration, explicit array
  length and `endsWith`).
- `src/core/engine.ts`, `src/core/tickets.ts`,
  `src/infra/environment.ts`, `src/sources/github.ts`,
  `src/sources/host.ts` and the touched runtime files: remove unused
  imports/locals required by the enclosing strict compiler.
- `tests/store.spec.ts`, `tests/sources.spec.ts`,
  `tests/feishu-read.spec.ts`, `tests/model-surface.spec.ts`,
  `tests/runtime.spec.ts`, `tests/runtime-concurrency.spec.ts`,
  `tests/fixtures/host.ts`: remove unused variables/imports or make an
  existing assertion/snapshot iteration explicit for repository lint.
  They retain their original behavioral assertions.

Task transitions, model admission judgements, report readiness rules,
effect retry schedules and the durable upstream schema remain upstream
implementations. The source-scope checks above enforce the host's current
source cancellation boundary before an old queued command can act.
For a targeted task Stop, the host adapter fences only its origin and
actually consumed requests from new routing or attachment. This fence
does not revoke the execution or approval grants of other existing
tasks which share a source request. Unread newer inputs remain eligible
for the official engine's normal handback and routing.

## OpenMausBot product seam

The parent gateway owns a private durable mapping of
`botId/threadId/contextId` to an opaque binding ID. Child prompts and
memory tools receive no model-selectable Bot identity. Reverse memory
requests are reconstructed from that trusted mapping and invoke the
original OpenMausBot memory service. Personal facts therefore retain the
original evidence, owner, visibility, recall and forget rules.
During recovery the adapter publishes an existing canonical ticket's
projection before requesting its parent-side Stop fence. This rebuilds
a missing host projection while retaining strict ticket and original
request checks; it grants no authority from model-supplied identifiers.

Every source request also retains its original product message ID in the
gateway database. The source awaits reverse `deliver` RPC; with the
product `deliver` callback installed, the parent durably stores the
official Outbox message before acknowledging it. Retry uses the stable
official message ID. Parent receipts and original product deduplication
cover a crash between persistence and acknowledgement. Stopped requests
and retired contexts are explicitly suppressed. The event-only fallback
without a `deliver` callback is intended for package consumers/tests; it
does not claim original product persistence.

An official result targets the ticket's original conversation. Its
completion notification and attention are correlated to the consumed owner
trigger of that same ticket, frozen when the reply is queued using report
time and input-read provenance. The native worker Session is flushed
before product result/attention delivery. Durable delivery is independent
of the current composer turn.
Attention remains a live official ticket while releasing the original
chat turn for clarification.

Each binding has one lazy managed DSH process; startup never spawns all
historical bindings. The default limit is eight live processes, including
the tool-free memory-upkeep process. Idle processes are evicted in last
use order; saturation by active work fails explicitly. Processes stop
through official Runtime shutdown, then bounded TERM/KILL if necessary.
After a successfully initialized exact owned child exits, the parent
removes only its empty proper-lockfile directory, avoiding the upstream
30-second stale-heartbeat delay without stealing another runtime's lock.

New source input resolves the current model and environment. Changed
configuration restarts an idle process and is explicitly rejected while
its request remains active. The successful-launch hook receives the
exact configured snapshot so an asynchronous older launch cannot mark
newer settings applied. A stop during launch fences admission before
`Runtime.receive`. Stop persists a pending recovery intent even if a
process already crashed. The gateway can lazily restore that exact
active binding to stop its open native tickets; the recovery hook runs
before native Session restoration. The source also rejects queued
candidates belonging to stopped requests, so cancellation cannot admit
an old candidate after the next input.

Ask uses native `workspace-write` with approval `ask`, consistent with
the original product's Codex Ask semantics; in-workspace edits are
allowed and wider operations ask. Full uses `danger-full-access` with
approval `never`. Other original approval modes conservatively use Ask;
the system does not claim a separate native automatic reviewer.

Native memory tools bind their caller to the main Session or a ticket's
worker and its consumed original source request, including the persisted
authorization version. Workers receive read tools and a proposal relay;
only the main assistant can request evidence-checked writes. A new chat
input does not upgrade an older worker's permission preset.

The DSH `llm/stream` waterfall wraps every actual main, worker and upkeep
model call with the parent's model admission lease. Adapter-reported usage
chunks are recorded under the call's stable lease ID; absent pricing is
left unknown. Native worker pre-step admission acquires the parent's
workspace lease, retained across model/tool steps, approvals, tests and
background execution. Main-Session mutating tools use the same host lease;
read and routing tools remain independent.

`generateText` uses one native `ctx.llm.stream` request with no tools or
Session history. It supports original memory upkeep without creating a
second Agent loop and passes through the same model concurrency and
accounting boundary.

## Verification

The package-owned native tests use disposable HOME/DSH_HOME/workspaces,
the actual native DSH executable, the actual upstream Runtime and a
deterministic model adapter. The adapter emits ordinary native tool calls;
native DSH file tools execute the file task. No real model, account,
GitHub call or live user App is involved.

Run from the repository root:

```sh
node --test packages/personbot-superagent/test/gateway.node-test.ts
pnpm exec tsc -p packages/personbot-superagent/tsconfig.runtime.json
```

Selected original domain/persistence suites run from `upstream/`:

```sh
pnpm exec vitest run tests/core-engine.spec.ts tests/store.spec.ts tests/outbox.spec.ts tests/delivery.spec.ts
```

The original product's browser, memory and recovery acceptance tests live
under the enclosing repository's `scripts/testing/`; those tests verify
the original Store/UI side of this seam.
