# Loops cutover TDD evidence

## RED — 2026-07-26

Command:

```text
npm run test:loops
```

Result: **4 failed, 0 passed** (exit 1).

Expected causes observed before implementation:

1. `ERR_MODULE_NOT_FOUND` for `scripts/lib/work-item-loop-contract.mjs`.
2. Missing `src/app/loops/page.tsx` (the old `/projects` tree still existed).
3. `ops/local-postgres/schema.sql` did not contain `public.loops` and retained the Projects schema.
4. `scripts/sync-local-core-from-cloud.mjs` did not include the Loop graph tables in dependency order.

This is the intentionally failing contract baseline. No runtime or database was changed while recording RED.

## Blocker RED — 2026-07-26

After the first cutover implementation, the fixture was expanded before production SQL/runtime changes with `pipeline_items.project_id` and `recurrence_rules.project_id` FKs plus named constraints/indexes, terminal orphan source history, an absent-primary-index scenario, and new static contracts. `npm run test:loops` returned **3 failed, 7 passed** (exit 1): PostgreSQL rehearsal selected the newly added orphan row and exposed missing handling, local review still assumed `last_completed_at`, and migration contracts lacked optional relation renames/locks, fallback CHECK/unique index, and orphan markers. This second RED was recorded before the blocker fixes.

## SQL Editor/autocommit incident RED — 2026-07-26

A dollar-quote-aware top-level SQL splitter and statement-by-statement autocommit executor were added before changing the migration. The targeted PostgreSQL test returned **1 failed, 2 passed** (exit 1). The new recovery test reproduced an incompatible cross-statement assumption immediately: forward statement 5 failed with SQLSTATE `25P01` (`LOCK TABLE can only be used in transaction blocks`). Static inspection showed the next cross-statement dependency was the incident's `CREATE TEMP TABLE ... ON COMMIT DROP`. This RED established that migration correctness could not depend on a surrounding transaction, temp/session objects, or locks surviving between SQL Editor statements.

## Provenance/adversarial RED — 2026-07-26

The independent review fixtures were encoded before the provenance fixes. They showed that rollback on untouched Projects created a helper and globally inverted Loop names/values, that `idx_work_items_loop_marker` was renamed despite not being produced by forward, and that a source CHECK named `work_items_source_type_loop_cutover_created` was dropped as if it were the fallback. Additional RED fixtures covered a CHECK without an exact `project` literal, a CHECK already containing exact `loop`, duplicate exact primary-execution partial indexes, and a helper-prefix object accepted by forward but rejected by preflight. The all-checkpoint harness identifies every forward statement capable of catalog/data mutation; transaction/session control and the two read-only guards are explicitly excluded.
