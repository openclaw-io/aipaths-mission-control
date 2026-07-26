# Mission Control Loops cutover SQL

These artifacts are versioned rehearsal/cutover inputs. They are **not** run by the application and were not applied to a live database while preparing this branch.

Order for each stopped, backed-up target database:

1. `preflight.sql` (read only; must succeed and record counts).
2. `supabase/migrations/030_projects_to_loops_total_cutover.sql` (transactional forward migration, used for both local PostgreSQL and cloud Supabase).
3. `postflight.sql` (read only; must succeed and counts must match preflight).

Run that sequence **independently in each store** (local PostgreSQL and cloud Supabase). Cloud → local sync is not a cutover step and must not be used to substitute for either store's migration. During a staggered rollout the sync is expected to abort loudly on unmapped column/schema drift; leave it stopped until both stores have completed and passed postflight, then reconcile intentionally before re-enabling sync.

If a maintenance-window gate fails, run `rollback.sql` before restoring the previous app/scheduler release. Migration 030 performs only reversible relation/column/object renames plus controlled key/value rewrites; it deliberately preserves each store's existing column types, defaults, nullability, primary keys, and cloud/local shape. The fresh-install canonical Loops baseline remains separately defined in `ops/local-postgres/schema.sql`.

All scripts use bounded lock/statement timeouts and fail explicitly on missing source objects, destination collisions, exact-FK mismatches, orphan references, or pre-existing destination controlled keys/values.

## Executable PostgreSQL rehearsal

Run:

```sh
npm run rehearse:loops
```

The rehearsal creates a uniquely named scratch database on the local PostgreSQL server and installs a drifted source-domain fixture including optional parent-link FKs on pipeline and legacy recurrence tables, plus their constraints and indexes. It exercises both an existing and an absent `work_items.source_type` CHECK, and both an existing and an absent legacy partial unique primary-execution index. It runs preflight/forward/postflight/rollback, verifies exact schema/data rollback fingerprints, proves duplicate primary execution receives SQLSTATE `23505`, proves non-terminal orphan sources are rejected, and adversarially proves postflight rejects leftover source-domain columns, constraints, and indexes. Override the admin connection with `LOOPS_REHEARSAL_ADMIN_URL`; no Mission Control live database is opened.
