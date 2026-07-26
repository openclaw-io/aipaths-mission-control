# Mission Control Loops cutover SQL

These artifacts are versioned rehearsal/cutover inputs. They are **not** run by the application and were not applied to a live database while preparing this branch.

Order for each stopped, backed-up target database:

1. `preflight.sql` (read only; must succeed and record counts).
2. `supabase/migrations/030_projects_to_loops_total_cutover.sql` (transactional forward migration, used for both local PostgreSQL and cloud Supabase).
3. `postflight.sql` (read only; must succeed and counts must match preflight).

If a maintenance-window gate fails, run `rollback.sql` before restoring the previous app/scheduler release. Migration 030 performs only reversible relation/column/object renames plus controlled key/value rewrites; it deliberately preserves each store's existing column types, defaults, nullability, primary keys, and cloud/local shape. The fresh-install canonical Loops baseline remains separately defined in `ops/local-postgres/schema.sql`.

All scripts use bounded lock/statement timeouts and fail explicitly on missing source objects, destination collisions, exact-FK mismatches, orphan references, or pre-existing destination controlled keys/values.

## Executable PostgreSQL rehearsal

Run:

```sh
npm run rehearse:loops
```

The rehearsal creates a uniquely named scratch database on the local PostgreSQL server, installs a drifted Projects fixture with a real `work_items.source_type` CHECK, runs preflight/forward/postflight/rollback, verifies controlled transformations and CHECK behavior, compares exact pre/post schema and data fingerprints, then force-drops only that scratch database. Override the admin connection with `LOOPS_REHEARSAL_ADMIN_URL`; no Mission Control live database is opened.
