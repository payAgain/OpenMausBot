# W5 runtime / integration correctness review

Reviewed current `runtime-plugin/src/tasks.ts`, runtime dispatch/shutdown, SupervisorStore event receipts, protocol validators, IntegrationStore ingress/schedules/outbox and callback transport against `/tmp/personbot-w5-contract.md`.

No production edits in this review. Added only the assigned new file:

`packages/personbot-runtime-plugin/test/event-effects.node-test.ts`

## Findings and resolution

### Event batch starvation — fixed

Original `pendingEvents()` took the first 64 pending rows before runtime checked whether the corresponding Tasks were paused/blocked/awaiting_review. Sixty-four retained intents could monopolize every pump cycle and prevent a later eligible Source from ever starting.

Reproduced with real SQLite and mock TaskRuntime ports: eligible task count remained zero across several pump cycles. Root now supplies suspended Task IDs to `pendingEvents(excludedTaskIds)`; Store filters before its bounded batch, checks live Source/subscription admission, uses a rotating cursor and preserves one pending head per task.

The regression now passes in approximately 155 ms. All 64 original Tasks remain paused, while the later eligible Source creates exactly one task and its trigger settles.

### Source/subscription disable during native drain — fixed

Original runtime checked enabled flags before entering an async per-task operation, awaited the native worker stop, then allocated a new Execution without checking the updated configuration. Disabling either Source or subscription during that wait still grew executions from one to two.

Both deterministic reproductions failed on the original code. Root/Store added `canDeliverEvent(deliveryId)` and recheck it inside the per-task lock, after native drain, and through the task-create admission callback. The two regressions now pass: the original task stays `waiting_event`, execution count stays one and its event stays durable/pending.

### Subscription rebinding and historical callbacks — fixed

Original `putSubscription` allowed changing its Source/thread/task while preserving an old `createdAt`. Because outbox fanout used that timestamp as its history floor, rebinding an old subscription to a new task/channel could enqueue results that predated the new binding.

Store now rejects changes to Source/thread/task identity and allows enabled edits. Reenabling establishes a fresh result history floor while preserving already queued immutable callback rows. Reviewed the new Store implementation and its dedicated regression; Store agent owns its execution evidence.

## Additional shutdown regression

Added a controlled shutdown while `ports.stop()` is awaiting for a waiting-task event. Runtime close waits for the drain, does not allocate another Execution, and leaves the event pending in SQLite. Reopening both stores proves the original waiting task and pending event survive.

## Verification

1. Before the fixes, the three targeted defect regressions **failed 0/3** with the expected business assertions, not fixture startup failures.
   - `/tmp/personbot-w5-event-effects.log`
2. After the fixes:
   - `node --test packages/personbot-runtime-plugin/test/event-effects.node-test.ts packages/personbot-runtime-plugin/test/task-effects.node-test.ts`
   - **8/8 passed**, 329 ms.
   - Includes the four new event/shutdown cases plus existing late-seal fencing, durable queued supplement, guard-through-shutdown and 40+40 report evidence cases.
   - `/tmp/personbot-w5-event-effects-final.log`
3. `pnpm personbot:typecheck` — **passed**.
   - `/tmp/personbot-w5-review-typecheck.log`
4. `pnpm exec oxlint --deny-warnings packages/personbot-runtime-plugin/test/event-effects.node-test.ts` — **passed**.
   - `/tmp/personbot-w5-event-effects-lint.log`

All fixtures used disposable temporary directories; no live App, personal profile, real account or remote provider. No commits/pushes.

## Product semantics to keep explicit

- Recurring schedules publish events into their configured thread. Automatic thread binding preserves the same task; after that task is completed/cancelled, later events are ignored rather than creating unrelated replacement work. The schedule UI/docs should not promise independent new completed tasks on every interval.
- Enabled flags gate new event/schedule admission and future callback fanout. Previously queued callback rows retain their frozen target and delivery lifecycle; an enabled toggle currently does not cancel an already queued outbox delivery.

No additional production fix requested from this review beyond the three resolved issues. Root still owns the full native/UI suite and final W5 acceptance.
