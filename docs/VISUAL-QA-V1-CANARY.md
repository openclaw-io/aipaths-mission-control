# Visual QA Runner V1 — local canary runbook

Status: **defined, not executed**. Run only after code review/PR approval and only against a disposable or local staging Mission Control database. Do not run this canary against production.

## Preconditions

- Runtime scheduler and Mission Control commits under test are pinned and recorded.
- Phase 5B migration plus `supabase/migrations/036_visual_qa_runner_v1.sql` have been applied; the read-only `verify.sql` passes.
- Mission Control and scheduler connect as `aipaths_mc_app` (`rolsuper=false`).
- `agent-browser` is exactly `0.33.2`; a Chrome for Testing executable exists under the runner user's `~/.agent-browser/browsers/` tree or is supplied through `AGENT_BROWSER_EXECUTABLE_PATH`.
- Hermes reviewer profile resolves to source `mission-control-visual-qa`, provider `openai-codex`, model `gpt-5.6-sol`.
- `HERMES_VISUAL_QA_ARTIFACT_ROOT` points outside Git and has enough free space.
- No QA execution is `running`.
- Each execution must create a fresh schema-only PostgreSQL cluster on a random non-5432 loopback port. Build/preview network remains denied except for that exact port; its URL must never reach Hermes, the browser, or logs.
- V1 runtime policy is capped at two viewport/flow combinations, six planner actions per combination, 60 seconds per Hermes turn, and 15 seconds per browser command. Capability lifetime is 90 minutes with a 10-minute cleanup/completion reserve.
- Use one disposable V2 Loop task whose target commit is known, clean, low-risk, and has a minimal required QA policy: one desktop viewport, one read-only flow, and a loopback target URL.

## Canary

1. Record the selected work-item ID, target SHA, repository identity, expected QA policy hash, and current counts for `qa_executions`, `loop_evidence`, and running QA rows.
2. Start Mission Control and the scheduler from the candidate commits with their normal protected service environments. Do not print environment values.
3. Trigger exactly one scheduler cycle, or call the dedicated authenticated endpoint once:

   ```bash
   curl --fail-with-body \
     --request POST \
     --header "Authorization: Bearer ${AGENT_API_KEY}" \
     --header 'Content-Type: application/json' \
     --data "{\"work_item_id\":\"${QA_CANARY_WORK_ITEM_ID}\"}" \
     http://127.0.0.1:3001/api/qa/dispatch
   ```

4. Expect `202` with the closed dispatch shape. Never copy the execution UUID into broad telemetry or chat.
5. Poll the database through a protected operator query until the execution is terminal. Do not dispatch a second item while it is running.
6. Verify the exact target SHA and policy hash; for any product verdict, verify `planner_session_id` is present and immutable. For an infrastructure failure before planning, it must remain null rather than be fabricated.
7. Verify the Hermes session in reviewer `state.db`: source, provider/model, one-turn bounds, first-turn lower bound, and reused session across the bounded flow.
8. Verify each required viewport/flow has PNG evidence, console/page diagnostics, and a canonical `loop_evidence` descriptor tied to the QA task/run/execution.
9. Fetch one evidence object through the authenticated evidence API and independently recompute SHA-256 and byte count. Confirm traversal, duplicate ownership, descriptor mismatch, and unauthenticated requests fail closed.
10. Confirm the preview/browser process group and disposable PostgreSQL exited, the source worktree registration was removed, temporary directories/socket were removed, and no QA execution remains `running`.
11. Re-run Mission Control health, scheduler health, `verify.sql`, and the zero/one-running invariant.

## Acceptance

- One claim, one execution, one terminal result; no generic notify/recovery path handles `visual_qa_v1`.
- Capability appears only on runner FD3 and nowhere in argv, env, logs, API responses, evidence, or scheduler telemetry.
- Browser opens only the randomized loopback preview origin, produces valid immutable PNG evidence, and closes cleanly.
- One global authenticated heartbeat remains active from execution validation through cleanup; any rejection fails closed.
- Product verdict is planner-session audit-bound; infrastructure failure contains no product findings.
- Database, task/run/work-item states, evidence ownership, and artifact hashes agree exactly.
- No leaked process, worktree, temporary directory, socket, or stale running authority.

## Abort and cleanup

Abort on any schema/role mismatch, second running execution, unexpected origin, planner-session mismatch, capability exposure, evidence mismatch, or cleanup failure. Stop additional dispatches, preserve logs/artifacts without posting sensitive identifiers, terminate only the recorded runner process group using the supported cleanup path, and let stale reconciliation revoke authority if terminal completion cannot be trusted. Diagnose before retrying; do not stack a second canary.
