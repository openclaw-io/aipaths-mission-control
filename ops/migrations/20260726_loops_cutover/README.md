# Mission Control Loops cutover SQL

These artifacts are versioned rehearsal/cutover inputs. They are **not** run by the application and were not applied to a live database while preparing this branch.

Order for each stopped, backed-up target database:

1. `preflight.sql` (read only; must succeed and record counts).
2. `supabase/migrations/030_projects_to_loops_total_cutover.sql` (transactional forward migration, used for both local PostgreSQL and cloud Supabase).
3. `postflight.sql` (read only; must succeed and counts must match preflight).

Run that sequence **independently in each store** (local PostgreSQL and cloud Supabase). Cloud → local sync is not a cutover step and must not be used to substitute for either store's migration. During a staggered rollout the sync is expected to abort loudly on unmapped column/schema drift; leave it stopped until both stores have completed and passed postflight, then reconcile intentionally before re-enabling sync.

If a maintenance-window gate fails—or if forward stops after any mutating checkpoint—run `rollback.sql` **statement-by-statement** before restoring the previous app/scheduler release. Do not rerun forward while the namespaced `__mc_loops_cutover_20260726_*` recovery objects exist: preflight and forward both reject the complete reserved helper prefix. They also reserve `public.uq_loop_work_items_primary_execution__cutover_created` schema-globally because PostgreSQL index names are not relation-local. Rollback accepts a complete Projects namespace only when durable metadata proves that forward started; on an untouched Projects namespace it rejects in the first read-only guard before creating helpers or changing schema/data. It also accepts the complete Loops namespace (partial/complete forward after the atomic rename), restores the exact original `source_type` CHECK definitions from durable metadata when present, and removes all helper objects. The fallback primary-execution index is deleted only when its owning relation and durable index comment prove that forward created it; this additional guard protects the SQL Editor autocommit window even though the name was globally free at entry. Migration 030 performs only reversible relation/column/object renames plus controlled key/value rewrites; it deliberately preserves each store's existing column types, defaults, nullability, primary keys, and cloud/local shape. The fresh-install canonical Loops baseline remains separately defined in `ops/local-postgres/schema.sql`.

Forward and rollback are compatible with Supabase SQL Editor executing each top-level statement in its own autocommit. `BEGIN`/`COMMIT` may be honored by a normal PostgreSQL client or ignored by a statement-by-statement runner; correctness does not depend on cross-statement transaction state. Plain session `SET lock_timeout`/`SET statement_timeout` statements keep timeouts effective in autocommit mode and successful artifacts `RESET` them. The scripts use no temp tables, `pg_temp`, `ON COMMIT DROP`, or cross-statement locks. The forward namespace rename is one atomic `DO` statement; durable namespaced metadata bridges all earlier checkpoints and is deleted on success.

## Executable PostgreSQL rehearsal

Run:

```sh
npm run rehearse:loops
npm run rehearse:loops:sql-editor
node scripts/rehearse-loops-cutover.mjs --sql-editor --inject-after-rename
npm run rehearse:loops:recovery
```

The first command executes each artifact transactionally. The second uses the dollar-quote-aware top-level SQL splitter and one autocommit per statement. The third retains the focused rename incident regression. The recovery command injects failure after all 14 top-level statements capable of catalog/data mutation and proves each statement-by-statement rollback returns schema and data to the exact pre-forward fingerprint with zero helper objects. Transaction/session control plus the two initial read-only forward guards are deliberately excluded because they cannot mutate catalog/data.

The rehearsal creates a uniquely named scratch database on the local PostgreSQL server and installs a drifted source-domain fixture including optional parent-link FKs on pipeline and legacy recurrence tables, plus their constraints and indexes. It exercises both an existing and an absent `work_items.source_type` CHECK, and both an existing and an absent legacy partial unique primary-execution index. It runs preflight/forward/postflight/rollback, verifies exact schema/data rollback fingerprints (including every non-helper index in `public`), proves duplicate primary execution receives SQLSTATE `23505`, proves non-terminal orphan sources are rejected, and adversarially proves: untouched-Projects rollback is mutation-free, source Loop-named indexes and the reserved fallback CHECK are rejected, the fallback index name is rejected even on an unrelated table and an unprovenanced late claimant survives recovery, every source CHECK is exactly transformable, helper-prefix residue is rejected identically by preflight/forward, exact partial-index multiplicity is gated early, and postflight rejects leftover source-domain columns, constraints, and indexes. Override the admin connection with `LOOPS_REHEARSAL_ADMIN_URL`; no Mission Control live database is opened.
