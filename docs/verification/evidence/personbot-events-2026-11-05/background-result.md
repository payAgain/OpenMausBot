# W5 eager background startup proof

Implemented only the new file `scripts/testing/personbot-background.test.ts`; no production changes, commits or pushes.

Validation passed:

- `pnpm exec vitest run scripts/testing/personbot-background.test.ts`: 1 test, 1 passed; 9.62 seconds total, 8.52 seconds test time.
- `pnpm exec oxlint --deny-warnings scripts/testing/personbot-background.test.ts`: passed with exit 0.

The test uses `launchVerificationServer(..., true)` and its deterministic dsh fixture, temporary HOME, Personbot home and workspace. Initial owner RPC creates main Session, an enabled `task-ready` Source, and a future one-shot schedule. It stops the original exact server and dsh child without removing the data, changes the schedule offline with IntegrationStore using a new command ID and revision, then spawns the exact server with the same fixture environment and port.

After restart it performs **zero HTTP requests**: no App, runtime RPC, webhook or health call. All assertions read fresh readonly SQLite connections and inspect the exact owned processes. It proves exactly one task reaches `awaiting_review`, `lifecycle=open`, `stopState=confirmed`, with `fixture:verified` evidence; exactly one execution and one delivered trigger target that Task. The one-shot disables itself and drops `nextRunAt`. Observation for a further 1.25 seconds preserves the same task/execution/trigger IDs with no duplicate.

Cleanup proves both server/runtime pairs exited before fixture data removal, and confirms the data directory no longer exists. No Source token or token hash is included in evidence.

Evidence:

- Test log: `/tmp/personbot-w5-background-test.log`
- Lint log: `/tmp/personbot-w5-background-lint.log`
- JSON: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793886818525-55048.log.personbot-background/evidence.json`
- Plain check log: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793886818525-55048.log.personbot-background/verification.log`
- Initial server log: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793886818525-55048.log`
- Restart server log: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793886818525-55048.log.background-restart.log`
- Original server/runtime PIDs: 55086 / 55132.
- Restart server/runtime PIDs: 55154 / 55162.
- Removed owned data directory: `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verify-data-vt25Yk`.

This closes the eager-start regression specifically; existing native restart tests alone could be satisfied by explicit initialize RPC and did not establish App-independent server startup.
