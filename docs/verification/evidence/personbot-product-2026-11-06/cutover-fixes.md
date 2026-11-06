# W6 cutover fixes — implemented and verified

No commit or push. Launcher untouched. Existing W0–W5 and other agents' edits preserved.

## Files

- server/index.ts: Primary now skips old followup recovery/queue restore, Routine running/waiting recovery via readonly construction, group-goal/request-receipt reconciliation, phone routine adoption/outside-lineage settlement, auto computer pins, room audience-floor migration, committed browser-profile reference repair/pending browser cleanup and shutdown interrupted-turn notes. The old coordinator receives an in-memory store in primary so lazy reads cannot open/reconcile the saved old runtime or call its recovery host; legacy mode still receives DATA_DIR.
- server/personbot-mode.ts/test.ts: Old bot browser paths and desktop-viewer paths denied for GET/HEAD/OPTIONS too. This runs in the authenticated HTTP handler before old viewer handlers, including upgrade requests, and before browser/desktop resolvers. History/read/import routes stay available.
- server/routines.ts: Minimal readOnly option suppresses constructor recovery and callbacks, start/tick and deferred saves; committed mutations fail 409 before mutation. Old mode unaffected.
- server/calendar-calls.ts: Minimal readOnly option suppresses old constructor schedule migration plus scheduler startup/ticks, and refuses committed edits. This was necessary because an older calendar file without nextRunAt was otherwise rewritten in the constructor even when the scheduler never starts.
- scripts/testing/personbot-cutover.test.ts: Isolated real-server/dsh cutover now seeds pending/dispatching/aside followups, running goal and waiting routine runs, a retained routine-request receipt, working goal card and old calendar records. It verifies upgraded WebSocket refusal, no GET viewer launch, native idempotent import, no old engine calls, byte-identical routines/calendar and record-identical old messages/followups through startup/read/import/shutdown. Corrected the overdue fixture to set nextRunAt as well as schedule.at.

## Validation

- pnpm exec vitest run server/personbot-mode.test.ts server/routines.test.ts server/calendar-calls.test.ts scripts/testing/personbot-cutover.test.ts: **4 files / 215 tests passed**, 15.85s. Log /tmp/personbot-w6-cutover-tests.log.
- pnpm exec tsc -p tsconfig.server.json: **passed**, /tmp/personbot-w6-cutover-types.log.
- Focused oxlint for all changed cutover files and separately server/index.ts: **passed**, /tmp/personbot-w6-cutover-lint.log and /tmp/personbot-w6-cutover-index-lint.log.
- Focused git diff --check: **passed**.
- pnpm personbot:typecheck: **passed**, /tmp/personbot-w6-cutover-package-types.log.

Integration evidence:
/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793894625947-76293.log.personbot-cutover/evidence.json

Exact owned server processes 76317 (legacy fixture) and 76378 (primary restart) exited; temporaryDataRemoved:true. Only deterministic fixture model and disposable HOME/DSH_HOME/workspaces. No user live app/data/credentials/external accounts used.

## Review findings status

Review finding 1 (archive mutation on startup/shutdown): fixed, regression verified.
Review finding 3 (legacy GET WebSocket bypass): fixed, regression verified.
Review finding 2 (launcher descendant leak): delegated to settings agent; not modified here.
