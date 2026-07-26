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
