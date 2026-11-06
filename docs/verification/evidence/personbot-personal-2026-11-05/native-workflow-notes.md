# W4 native personal/workspace/artifact integration verification

Owned file: `packages/personbot-runtime-plugin/test/personal.node-test.ts` only.

Final command:
`node --test packages/personbot-runtime-plugin/test/personal.node-test.ts`
Result: **2/2 passed**, 6.18 seconds.
Full log: `/tmp/personbot-w4-native-tests.log`.

## Actual native input and memory lifecycle

The first integration case creates a directory project, custom role and personal/project memories through native RPC, then creates a bound native Session. The deterministic adapter echoes the context it actually received:

- Frozen role instructions and active personal/current-project memories are present.
- Another project's memory is absent.
- The human transcript projection contains exactly the original `context` command, without the injected block.
- Editing role configuration leaves the original Session on revision one; a new Session receives revision two.
- The native memory proposal tool creates an attributed proposed project memory that is excluded from recall until human confirmation.
- Confirmation activates recall; human correction supersedes the prior fact.
- A stable input retry produces only one native user message and no extra turn.
- Correction and the original Session's frozen role survive actual native runtime restart.
- Forget removes the fact from subsequent actual context without removing other active memories.

## Actual Git workers, approved files, immutable artifacts and supplements

The second case creates a real temporary Git repository and initial commit, then leaves both an uncommitted tracked edit and an untracked private draft in the source. Two independent native tasks use the same custom project/role:

- Their native worker directories are separate Git worktrees, distinct from source and each other.
- Each worktree contains the committed version; source dirty files are not copied or modified.
- Native explicit approval gates the controlled `fixture-output.md` file write.
- Native artifact publication returns one artifact referenced in the worker's structured review report, with the correct task/execution/Session/origin/project attribution.
- Actual native worker input contains the custom role.
- Artifact reads still return original copied bytes after the worker output file is rewritten and deleted.
- Source Git status, tracked dirty file, private untracked file and absence of generated output remain unchanged.

A separate native worker asks a real user question. While waiting_person, a supplement is submitted, replayed with its stable command identity and observed in the native worker inbox before answering the question. Its final review summary includes the supplement, with the same task/worker/Execution, one supplement message and no second Execution. Task messages, confirmed review state and immutable artifact reads survive another actual runtime restart.

## Defect exposed and remediated

The initial run failed both cases because `source.personbotContext` carried own `undefined` properties, rejected by dsh's strict JSON Session validation. Root fixed the production metadata builder. Tests passed afterward without weakening those assertions. Fixture command dispatch was also corrected by root to honor the marked final human text block.

## Checks and isolation

- Focused oxlint for the owned native test: passed, `/tmp/personbot-w4-native-lint.log`.
- Final global `pnpm personbot:typecheck`: passed, `/tmp/personbot-w4-native-types.log`.
- Temporary HOME/DSH_HOME/profile/workspace only; deterministic native adapter; sanitized runtime environment.
- Local Git commands disable personal/global config and hooks and use synthetic commit identity.
- Exact owned runtime handles are closed and fixture directories removed by after-hooks.
- No production files, existing tests, personal profile, credentials, live App, commit or push touched during this follow-up.
