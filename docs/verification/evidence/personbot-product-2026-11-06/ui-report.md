# W6 primary frontend — implementation complete

UI source is FINAL and ready for the root production build. No commit/push. Existing W0–W5 work preserved. No dependency or dsh version changes.

## Delivered behavior

- `src/App.tsx` checks `/api/personbot/setup` before mounting the legacy StoreProvider/onboarding. Primary mode enters dedicated Personbot; explicit legacy mode retains existing App. Connectivity failure offers retry and does not pretend setup succeeded.
- `PersonbotProduct.tsx` provides seven labelled destinations: 对话、长期任务、项目与记忆、产物、事件与渠道、旧历史、模型设置. Native chat stays mounted when settings/history open, preserving drafts. Primary product lifetime sets browser title Personbot and restores the previous title on unmount. Navigation becomes a drawer below900px. Explicit worker selection returns to native conversation history.
- `PersonbotView.tsx` supports primary sections; each management area has its own page rather than stacking above all chat. Existing legacy behavior retained. Task acceptance/control remains visible in worker conversations. Errors remain visible on management pages.
- `PersonbotSetup.tsx` uses shared official pinned provider model catalog. Write-only credential input has no browser persistence; environment-owned keys cannot misleadingly be overwritten. Clear saved key is explicit. Accepted response loss reuses the same command ID and expected revision. Settings receipt is followed by a fresh GET. Existing runtime configuration changes truthfully say to stop active work and restart the Personbot service; no invented hot-apply endpoint.
- `PersonbotLegacy.tsx` lists/paginates read-only old history with source role, attachment filenames and truncation labels. Explicit import requires owner-confirmed goal/progress, previews optional project/role import and creates one new native session with stable retry command. Import input matches backend byte bounds. Stale pagination cannot overwrite a subsequently selected thread.
- `PersonbotClient.suspend()` closes streams/timers without permanently aborting reusable lifetime. Missing/removed credentials prevent native execution; product unmount disposes client.
- New shared-type helper `src/lib/personbot-product-client.ts` preserves mutation identity after ambiguous failures, clears after definite rejection/new payload, and encodes opaque history IDs as one URL segment.

## Owned modified/new files

`src/App.tsx`; `src/components/personbot/PersonbotProduct.tsx`, `PersonbotProduct.test.ts`, `PersonbotSetup.tsx`, `PersonbotLegacy.tsx`, `PersonbotView.tsx`, `PersonbotPersonal.tsx`, `PersonbotIntegrations.tsx`, `personbot.css`; `src/lib/personbot-client.ts`, `personbot-product-client.ts`, `personbot-product-client.test.ts`; `scripts/testing/personbot-product-ui.e2e.test.ts`.

## Final verification

- Focused7file suite: **51/51 passed**. `/tmp/personbot-w6-ui-tests-final.log`.
- Full renderer `pnpm exec tsc -b --pretty false`: exit0. `/tmp/personbot-w6-ui-types-final.log`.
- Focused oxlint: exit0. `/tmp/personbot-w6-ui-lint-final.log`.
- `git diff --check`: exit0.
- Root-requested final tab-title effect passed focused Product test2/2 (`/tmp/personbot-w6-ui-title-test.log`).
- Actual root App browser recipe: **1/1 passed**, after all final UI changes. `/tmp/personbot-w6-ui-browser-final.log`.
- Authoritative final browser evidence:
  `/var/folders/3l/0349g8494hb2yltn7j0yj23r0000gn/T/openmausbot-verification-evidence/server-1793894411600-74522.log.personbot-product/`
  Contains `evidence.json` and six screenshots `personbot-product-{1440,768,390}.png` + `personbot-model-settings-{1440,768,390}.png`.
- Browser proves primary boot without old onboarding/engine UI; actual pinned native dsh fixture reply; settings response-loss retry and retained chat draft; independent task worker/native history/human acceptance; personal memory/event destinations; seed old history then restart primary and import confirmed goal/progress once despite accepted response loss; native history recovers on reload; responsive controls stay within1440/768/390; browser console0errors.
- Exact owned browser, old/primary fixture servers and dsh runtime exited. Disposable data removed; `temporaryDataRemoved:true`. No live data, external accounts or model calls.
- All six screenshots from the preceding successful run at `server-1793893952010-71049.log.personbot-product/` were visually inspected; final run preserves the same geometry and records fresh screenshot evidence.

## Design evidence and critique

Applied design-taste-frontend app guidance with achromatic-ledger direction seed2009951163 and retained established theme/type. The product has7real destinations and a persistent task/approval workflow, so labelled inbox sidebar pattern was chosen instead of the sheet's default few-link report shell. Ground/chrome remain quiet and monochrome; status communicates runtime connection and pending review only from actual state. No invented counts/charts or production sample data. Generated repo `.taste-skill/direction.json` removed after preserving `/tmp/personbot-w6-ui-direction.json`; draw notes `/tmp/personbot-w6-ui-design.txt`. Skill source lint0FAIL/0WARN (`/tmp/personbot-w6-design-lint.log`).

First-screen question is “what can I ask my own agent to do, and is it connected?” Composer/session selector and connection state answer it directly. Desktop keeps navigation separate from the transcript. Mobile shows one workspace at a time; the drawer keeps all destinations available, forms wrap without horizontal scrolling, and the composer remains reachable.390px chat has a tall session/context header, leaving a smaller transcript above the composer, but all controls remain usable and measured inside the viewport. Settings save action is distinct and credential state is explained without exposing a key.

Production design verification is complete. First isolated static-dist inspection found a misleading page-level `data-ui` marker and settings content capped inside a wider page. Removed the marker and centered the settings section at744px so its680pxform fills the inner canvas. Final `pnpm exec vite build` passed (`/tmp/personbot-w6-ui-inspector-build.log`), then actual built root-owned demo `http://127.0.0.1:21366` passed both skill inspector runs: **chat0FAIL/0WARN; settings0FAIL/0WARN**. Logs `/tmp/personbot-w6-design-final-chat.log`, `/tmp/personbot-w6-design-final-settings.log`; reports and six final fold screenshots under `/tmp/personbot-w6-design-final/{chat,settings}/`. All six final production fold screenshots at1440/768/390 were opened and visually inspected. Inspector browsers closed themselves; root-owned demo intentionally remains running. The initial owned isolated inspection fixture77976exited and its temporary data was removed (`/tmp/personbot-w6-design-production/cleanup.json`).

Final app critique: (1) Chat reads first as the current conversation and reachable composer; settings reads first as model configuration. (2) Conversation aligns within one bounded transcript column; centered settings removes the former dead strip. (3) Existing dark/Geist face and monochrome chrome are retained; only actual connection/review state and the save action carry emphasis. (4) No generated totals, charts or financial figures; model/provider and runtime status agree with the live fixture. (5) The one visible task count is the actual awaiting-review queue count; empty workspace shows honest absence. (6) No legends or chart labels to contradict data; long file paths wrap or truncate inside their bounds. (7) Phone hides the sidebar behind a labelled menu, keeps the conversation, save action and composer within390px, and wraps form fields without horizontal overflow. Mobile context header is taller than desktop and intentionally leaves less transcript above the composer. Fixture welcome conversation and pending task are synthetic demo content, explicitly described as an isolated demo; no production evidence is invented. No inspector rule allowances were used.

## Integration bootstrap regression resolved by root

Root resolved the identified legacy hosted member bootstrap regression in `server/routes/personbot-setup.ts`: live authenticated nonowner GET in explicit legacy mode returns only `{primary:false}`; POST remains owner-only and revoked sessions are rejected. Shared `PersonbotProductBootstrap` and `readProductBootstrap` now distinguish the public mode response from the full owner setup snapshot. Root added an HTTP regression and owns its verification. See `/tmp/personbot-w6-ui-root-bootstrap.md`.
