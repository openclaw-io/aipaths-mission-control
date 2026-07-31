# Project Loops V2 Phase 5B.1 — local PostgreSQL migration

This package is **manual and local-only**. It does not deploy, invoke a browser, read evidence objects, make network calls, or mutate a database unless an operator explicitly runs its SQL against that database.

## Security model

Phase 5B.1 separates ordinary application SQL from the visual-QA authority boundary:

- `aipaths_mc_app` is the passwordless local runtime `LOGIN` role. It is `NOSUPERUSER`, `NOINHERIT`, `NOCREATEDB`, `NOCREATEROLE`, and has exactly zero role-membership edges: it cannot `SET ROLE` into another role and no privileged/owning role can become it through a grant.
- `aipaths_mc_qa_owner` is a `NOLOGIN` owner for QA authority tables and fixed `SECURITY DEFINER` functions.
- `aipaths_mc_qa_owner` likewise has exactly zero membership edges in either direction. Preflight, forward, and verification reject any `pg_auth_members` row involving either fixed role.
- The app may read `qa_executions`, but cannot insert, update, delete, truncate, re-key, or read `qa_authority_secrets` or the transaction-scoped transition proof table.
- The app can execute only the claim, heartbeat, completion, and stale-reconcile authority entry points. The work-item transition helper and trigger functions are private.
- Every `SECURITY DEFINER` function is owned by `aipaths_mc_qa_owner` and pins `search_path` to `pg_catalog,public`.
- `PUBLIC` and `aipaths_mc_app` cannot `CREATE` in schema `public`; both fixed roles retain `USAGE`. This prevents untrusted search-path object replacement in the fixed `SECURITY DEFINER` functions.
- The migration installs dynamic default table/sequence privileges for the migration executor so future ordinary public tables remain usable by `aipaths_mc_app`. Explicit revokes on QA authority tables override the broad current-object grants.

The migration and rollback perform cluster-role/default-privilege DDL and therefore **must be run by a PostgreSQL superuser**. Run rollback as the same superuser that ran forward so it removes that executor's default ACLs. The fixed roles are intentionally not dropped by rollback because one PostgreSQL cluster can host multiple databases using them.

## Forward procedure

1. Take and verify a database backup.
2. Drain all V2 Loop runs and review executions.
3. Generate one 32-byte key as exactly 64 lowercase hexadecimal characters. Keep it out of shell history and logs.
4. Run `preflight.sql` against the intended local database as its superuser migration executor.
5. Run `forward.sql`; it is internally transactional.
6. Install the chosen key through the superuser-only invoker function, using a protected parameter rather than embedding it in a checked-in SQL file:

   ```sql
   SELECT public.install_qa_authority_hmac_key(:'qa_authority_hmac_key');
   ```

7. Set Mission Control's `QA_AUTHORITY_HMAC_KEY` to **the exact same lowercase hex value installed in step 6**. Only a process that signs QA claim envelopes needs this secret; do not broaden it to the scheduler unless that deployment explicitly makes the scheduler a signer. A mismatch makes every signed claim fail closed. Rotation uses the same install function and requires a coordinated drain/cutover because claims signed with the old key stop validating immediately.
8. Run `verify.sql`; it uses `SET TRANSACTION READ ONLY` and checks zero role-membership edges, schema `USAGE`/`CREATE`, ownership, fixed search paths, grants/default ACLs, secret presence without returning key material, integrity triggers, and live row coherence.
9. Set `MISSION_CONTROL_DATABASE_URL=postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local` in both the Mission Control and work-item scheduler service environments. Set the aligned HMAC key only in Mission Control/the designated claim signer. Do not put the key in checked-in plist files, command output, or URLs.
10. Build Mission Control, then reload/restart Mission Control and the scheduler so both processes discard old superuser connections and environment values. Do not enable Phase 5B.1 traffic between the database migration and these two role/env reloads.
11. From each service's effective database URL (or a service health probe that performs the same query), verify `SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user` returns `aipaths_mc_app,false`. Then run one scheduler status/health check and one Mission Control health check before re-enabling traffic.

Never place the HMAC key in migration output, logs, the database URL, evidence, or API responses. `verify.sql` checks only row count and key length; it does not print the secret.

Historical tasks whose frozen metadata has no `qa_policy`, or has canonical `qa_policy.required=false`, retain Phase 4 completion semantics. Required QA is created only by a new strongly isolated approval transition.

## Rollback safety

`rollback.sql` restores the exact Phase 4 constraints, quality-integrity triggers, and terminal immutability in one transaction. It takes exclusive locks and refuses **before destructive DDL** if any QA execution, QA run/work item, `qa_pending` task, or QA authority/event exists. A refusal leaves the blocking authority/event intact for inspection.

Use rollback only before Phase 5B.1 has accepted real QA work. It removes the secret table, all QA entry points/helpers, app table/sequence grants, and the executing superuser's Phase 5B.1 default ACLs. It retains the two cluster roles, their safe schema `USAGE`, and the `REVOKE CREATE ON SCHEMA public FROM PUBLIC, aipaths_mc_app` hardening. Rollback intentionally never re-grants insecure `PUBLIC CREATE`; tests treat this hardening as expected residue. Roll application code/configuration back at the same time; Phase 4 does not support the Phase 5B.1 non-superuser runtime grant set.

## UTF-8 and PostgreSQL jsonb parity

Policy/result string limits are UTF-8 byte limits. TypeScript rejects embedded U+0000 anywhere, as well as either lone UTF-16 surrogate, before opening the result-completion transaction or sending policy JSON to PostgreSQL. SQL mirrors the all-byte NUL rejection defensively, but PostgreSQL `jsonb` itself cannot represent U+0000; callers must rely on the deterministic TypeScript 400/validation failure rather than attempting a cast and surfacing a database runtime error.
