# Portable repository-root constraint (GON-124)

Mission Control enforces the environment-aware repository allowlist in application code after
canonicalizing every configured root and candidate with `realpath`. The database keeps a second,
portable structural guard: registered roots must be absolute, non-root paths without control
characters. PostgreSQL cannot safely encode the machine-specific allowlist because it cannot read
`AIPATHS_REPOSITORY_ROOTS` or `AIPATHS_AGENTS_DIR`.

Local Postgres rollout:

1. Run `preflight.sql` read-only.
2. Run `forward.sql` in the same maintenance window as the GON-124 runtime.
3. Run `verify.sql` read-only.
4. Deploy the exact reviewed Mission Control commit with the atomic deploy flow.
5. Before registering an agent repository, smoke both configured roots and one outside path.

`rollback.sql` restores the former `/Users/joaco/openclaw/` constraint only while every registered
repository still fits it. Once a repository from the agents tree is registered, rollback refuses
instead of deleting or rewriting repository identity.

`supabase/migrations/040_repository_roots_allowlist.sql` is the schema-parity artifact. Mission
Control production remains local Postgres.
