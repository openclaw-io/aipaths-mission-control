# Project Loops V2 — Phase 4 Fresh Review + Quality Cycles

Rollout **local Postgres only**. `supabase/migrations/034_project_loops_v2_quality_cycles.sql` is retained solely for schema parity; do not apply it to cloud Supabase.

Order:

1. Drain **all Phase 3 V2 work** first. Every V2 Loop must be terminal and every V2 run must be non-active.
2. Run `preflight.sql`; it fails closed on nonterminal V2 Loops, active V2 runs, any globally incompatible run cycle/duplicate identity, `in_review` rows without fresh-review history, or serial-work conflicts.
3. Run `forward.sql` in a maintenance window.
4. Register and explicitly enable the canonical repository using the server-inspected identity:

   ```bash
   npm run review-repository:register -- \
     --key aipaths-mission-control \
     --path /Users/joaco/openclaw/repos/aipaths-mission-control-live \
     --enable
   ```

   The command is transactionally idempotent only when key, canonical root, Git common dir, and object format all match. Any identity collision fails closed.
5. Run `verify.sql` (read-only). It requires at least one explicitly enabled review repository.
6. Deploy the matching runtime and external scheduler in the same release.

Phase 3 historical V2 review rows are backfilled only from the exact `output.head_sha` of their linked implementation run. Preflight rejects any V2 review that cannot be recovered exactly. Legacy compatibility reviews remain on the original branch (`review_run_id`/`quality_cycle` null): a valid linked `output.head_sha` is preserved when present, otherwise they receive the reserved all-zero SHA marker. Neither form is promoted to fresh-review evidence.

`rollback.sql` is guarded and refuses to remove the schema once any `fresh_review_v1` work item, review run, artifact/session identity, fresh quality-review decision, or reviewer execution exists. Repository-registration rows alone are safe pre-runtime metadata and are removed with the Phase 4 table during an immediate rollback. Compatibility-only historical reviews are preserved.

Phase 4 fixes the quality-cycle ceiling at three and derives cycle state from immutable implementation/review runs. It does not mutate approved plan/task metadata.

## External scheduler rollout dependency

The scheduler is maintained in a separate repository and must be deployed in the same rollout. It must:

- dispatch ready `fresh_review_v1` work through `POST /api/reviewer/dispatch` (never through the generic notifier), and
- call authenticated `POST /api/reviewer/reconcile` at least once every 10 minutes (recommended every minute).

The dispatch contract is a closed union:

- `202` newly claimed: exactly `{ok:true,state_claimed:true,started:true,execution_id,status}` with status `running` or fast-terminal `succeeded`;
- `409` idempotent duplicate: exactly `{ok:true,state_claimed:true,already_running:true,execution_id,status:"running"}`;
- every other HTTP/body combination is a dispatch error. Every known pre-claim rejection returns `state_claimed:false`; every post-claim failure returns `state_claimed:true` plus `execution_id` and must never be reverted through generic recovery. Only an actually ambiguous transaction outcome omits `state_claimed`.

Do not enable Phase 4 materialization until that scheduler release is active. The runner heartbeats once per minute during the bounded 30-minute Hermes call; reconciliation is the fail-closed recovery path when the runner, host, or database heartbeat infrastructure dies.
