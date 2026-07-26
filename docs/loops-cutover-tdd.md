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
