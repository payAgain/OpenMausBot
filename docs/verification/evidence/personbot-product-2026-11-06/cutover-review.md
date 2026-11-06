# W6 root-owned cutover and launcher independent review

Result: **three actionable findings**. Findings 1 and 3 are now implemented and regression-verified; see `/tmp/personbot-w6-cutover-fixes.md`. Launcher finding 2 is owned by settings agent. Review was read-only for production. Two defects reproduced in disposable fixtures; one bidirectional socket bypass follows directly from the existing route and guard contracts. No live user data, accounts or external services touched.

## 1. Primary startup rewrites the archived history and consumes in-flight old input [P2]

Location: `server/index.ts` around15606–15636, the unconditional `followupAtBoot`/`chatFollowups` recovery before `server.listen`.

Trigger: a saved legacy workspace has a `dispatching` or `interrupted` chat followup when switched to primary. The primary startup still appends that row as a new user message, appends an activity warning, updates old handed-message state, and deletes the original durable followup. This contradicts the explicit read-only legacy archive and makes rollback data differ even if the owner never requested import.

**Actual reproduction passed:** `/tmp/personbot-w6-startup-review-repro.ts` launched an isolated legacy fixture, created one bot, stopped the owned server, seeded one `dispatching` followup offline, restarted the same fixture in primary, then read archive. Evidence `/tmp/personbot-w6-startup-review-repro.json` records `sourceWasChanged: true`, the new `REVIEW_UNSENT_ARCHIVED_INPUT` user row and activity row, and `afterQueue: []` despite only read requests after restart. `tempDataRemoved: true`; both exact fixture server processes71527/71554 exited. Log `/tmp/personbot-w6-startup-review-repro.log`.

Related startup writes should be guarded in the same fix: `new RoutineManager` at index≈8832 calls its constructor's running/waiting-run recovery (`server/routines.ts`≈355–378), which saves runs and emits onRunCut/onRunFailed callbacks without `.start()`; index≈8970 `reconcileInterruptedGroupGoals` and routine-request reconciliation remain unconditional; primary shutdown `noteTurnsCutByShutdown` can likewise append legacy activity. The existing test's overdue future-scheduled run remains idle and does not expose these cases.

Suggested fix: primary mode skips legacy recovery/normalization mutations, not only scheduling, or uses an explicit read-only constructor mode for managers it must retain. Add a cutover regression containing an in-flight followup and running/waiting routine; prove original history, queue and routine file bytes/records remain unchanged through startup/read/shutdown and no engine executes.

## 2. Cancelling first build leaves an owned build descendant alive [P2]

Location: `scripts/personbot-start.ts` `stopChild()`≈31–39 and build spawn≈103–113.

`stopChild()` signals only the pnpm parent PID and returns immediately when that PID exits. pnpm runs a script shell which in turn owns TypeScript/Vite/build helpers, so parent exit is insufficient to prove those owned build processes stopped. This affects the normal first-start flow, which builds before serving.

**Actual isolated reproduction:** `/tmp/personbot-w6-launcher-review-repro.json` records launcher71425 exited0 after SIGTERM, fake build parent71427 exited, but its known child71428 remained alive. The fake npm_execpath script simply spawned a long-running Node child, matching pnpm's process-tree shape. Review explicitly terminated71428 after observation and `ps -p71428` returned no row; temporary repro directory removed. No actual build was performed or source changed.

Suggested fix: own and terminate the spawned build process group/tree on supported macOS/Linux, including descendants even after the immediate parent exited. Add a meaningful launcher signal test with a build child that owns one descendant and verify both exact PIDs exit. Preserve normal server/runtime graceful cleanup.

## 3. GET WebSocket upgrade bypasses the blanket legacy read-only mutation gate [P2]

Location: `server/personbot-mode.ts` `primaryMutationRefused()` returnsfalse for every GET; `server/index.ts` still wires `createBrowserViewerRoutes` and `desktopViewer.route` in primary.

Authenticated GET `/api/bots/:id/browser/stream` upgrades to a bidirectional browser socket. `server/routes/browser-viewers.ts`≈146–159 forwards `canOperate: url.searchParams.get('interactive') !== 'false'`, defaulttrue, and subsequent socket messages execute browser actions without another HTTP mutation gate. GET `/api/desktop-viewer/.../websockify` similarly pipes bidirectional RFB bytes (`server/routes/desktop-viewer.ts`≈150–175). Thus primary's all-GET exception keeps old browser/desktop command surfaces writable and can launch/use the old browser runtime through GET. The guard's docstring and delivery claim currently say every legacy execution surface is read-only.

No live browser was opened for this finding. This is a concrete route contract, not a hypothetical model bypass: GET reaches `upgrades.pending(req)`, detaches the socket and allows interaction. I did not find an old Agent model dispatch bypass through the guarded startTurn/runClaimedGroupMemberTurn paths.

Suggested fix: primary mode refuses the old interactive viewer paths/upgrades before resolving/opening their browser/desktop, or explicitly disables operation and any GET-triggered launch. A regression should attempt GET upgrade and prove denial before browser/target resolver/action callbacks.

## Otherwise reviewed

- Default personal source mode and explicit `PERSONBOT_PRIMARY=0` rollback are coherent; hosted/Cloud primary is rejected.
- Native source ingress intentionally runs before App authentication with separate Source Bearer; ordinary legacy POST mutations are rejected before handlers.
- New migration/setup route registration ordering is correct, before the generic Personbot catch-all.
- Runtime then migration shutdown is now one ordered cleanup job, avoiding the earlier SQLite close race.
- `personbot-cutover.test.ts` meaningfully proves settled legacy history import, fixed native continuation and no overdue old scheduler call, but should extend the crash/recovery/read-only cases above.
- No other concrete production-blocking issue was found within this bounded review. No full test/build suites rerun.
