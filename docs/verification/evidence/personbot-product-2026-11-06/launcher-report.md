# W6 launcher robustness — complete

Owned files: `scripts/personbot-start.ts` and `scripts/testing/personbot-start.test.ts`. No commit or push.

The launcher now spawns the build runner and normal server in exact-owned POSIX process groups. Cleanup checks the complete group even if its leader exited, sends TERM, and escalates to KILL within a bound. Build cleanup has a 2-second grace; the normal server first receives its own TERM and has 15 seconds for gateway/dsh shutdown before group escalation. No process-name or broad process-tree kills are used.

Child exit/error observation is installed at spawn, so fast build failure and spawn errors cannot leave a missed-exit wait. Successful builds also clean any leftover descendants. Demo fixture startup receives the launcher's AbortSignal; signal handlers remain installed until cleanup finishes. Normal server readiness also verifies the health PID belongs to the owned child.

Final validation on current W6 dist/source:

- `pnpm exec vitest run scripts/testing/personbot-start.test.ts`: **5/5 passed**, 11.68 seconds. Full log: `/tmp/personbot-w6-launcher-tests-final.log`.
- `pnpm exec oxlint scripts/personbot-start.ts scripts/testing/personbot-start.test.ts`: exit0.
- `pnpm personbot:typecheck`: exit0 after production launcher changes. The subsequent edits were test/evidence handling and removal of an unnecessary catch comment.

The five tests cover:

1. Interrupt an isolated fake npm package runner owning a TERM-ignoring child. Launcher exits0; owned runner and child are gone; an unrelated explicitly owned test process remains alive.
2. Fast build failure exits with a useful diagnostic instead of hanging on a missed exit event.
3. Missing package-runner binary reports ENOENT and exits without a cleanup hang.
4. Actual `--demo --skip-build` serves the production static UI, reports primary fixture setup, completes a native deterministic dsh echo, and stops both server and runtime before deleting demo data.
5. Normal source `--skip-build --home ... --workspace ... --port ...` with stripped credential-free environment and isolated HOME/DSH_HOME/OMB_DATA_DIR serves the production UI, reports primary setup with missing credentials, starts no dsh/legacy children, stops the owned server, and retains persistent Personbot home until explicit test cleanup.

Evidence:

- Interruption: `/tmp/personbot-w6-launcher-interruption.json` (launcher79840, runner79843, child79844; owned processes gone, unrelated process alive at assertion).
- First use: `/tmp/personbot-w6-launcher-first-use.json` (launcher79917/server79918; runtime stopped, no children, server exited).
- Demo evidence directory: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/personbot-launcher-1793895223622-79838`.
- The persistent demo directory contains `evidence.json`, `launcher.log`, and `server.log`. Pointer: `/tmp/personbot-w6-launcher-evidence-path.txt`.
- Demo launcher79850/server79851/runtime79872 all exited. `evidence.json` confirms server/runtime stopped and demo data removed; a separate filesystem check confirms both demo data and its temporary HOME no longer exist.
- Latest demo stdout/stderr: `/tmp/personbot-w6-launcher-demo-output.log`.

Root corrected the existing fixture helper's legacy starter read/rename before the successful smoke (`scripts/control-omb.ts` skips it for primary fixtures). Early failed logs are historical and superseded by the final5/5 run.

Qualification is macOS source startup using pinned dsh. Windows process-group cases are skipped; this is not packaged desktop or independent Linux qualification. The separate root-owned product preview was not touched.
