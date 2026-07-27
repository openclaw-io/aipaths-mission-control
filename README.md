# 🛰️ AIPaths Mission Control

A dark-themed dashboard for managing AI agents, tasks, cron jobs, memory logs, and the Intel Inbox. Built with Next.js, TypeScript, Tailwind CSS, local Postgres, and Supabase auth/bootstrap integrations.

## Local setup

### 1. Clone the canonical checkout and install

```bash
git clone https://github.com/openclaw-io/aipaths-mission-control.git /Users/joaco/openclaw/repos/aipaths-mission-control-live
cd /Users/joaco/openclaw/repos/aipaths-mission-control-live
npm install
```

All checked-in macOS service files use this canonical checkout path. Do not point a LaunchAgent at the retired `aipaths-mission-control` checkout.

### 2. Create and initialize local Postgres

The supported local target is exact: loopback host `127.0.0.1` or `::1`, database `aipaths_mission_control_local`. The safety-sensitive scripts reject other hosts, database-name prefixes/suffixes, URL overrides, and cloud fallbacks.

```bash
/opt/homebrew/opt/postgresql@16/bin/createdb \
  --host=127.0.0.1 --username=joaco aipaths_mission_control_local
/opt/homebrew/opt/postgresql@16/bin/psql \
  'postgres://joaco@127.0.0.1:5432/aipaths_mission_control_local' \
  --set=ON_ERROR_STOP=1 \
  --file=ops/local-postgres/schema.sql
```

`schema.sql` creates the local-only baseline and leaves imported data tables empty. It only seeds local runtime configuration.

### 3. Configure `.env.local`

```bash
cp .env.example .env.local
```

Required for the local runtime and local write scripts:

```dotenv
MISSION_CONTROL_DATABASE_URL=postgres://joaco@127.0.0.1:5432/aipaths_mission_control_local
```

Supabase variables remain necessary for auth and for the one-time cloud-to-local bootstrap, but `SUPABASE_SERVICE_ROLE_KEY` is never a runtime database fallback:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (bootstrap/admin scripts only)

Other runtime integrations may require `AGENT_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `WEBSITE_SUPABASE_URL`, or `WEBSITE_SUPABASE_SERVICE_ROLE_KEY`. `DISCORD_TASK_ROUTER_WEBHOOK` is optional.

### 4. Bootstrap local data from cloud

On a fresh local database, run:

```bash
node scripts/sync-local-core-from-cloud.mjs
```

Default behavior is bootstrap-only: the script checks local emptiness before cloud reads and performs no `TRUNCATE`. It fetches and preflights the complete imported dependency set, including `pipeline_runs`, `loops`, relation tables, and every `work_items.parent_id`. Missing parents, schema drift that would drop cloud fields, missing tables, or unknown dependent local tables abort before mutation.

If the local database contains data, the script exits without touching it. Intentional replacement requires the exact database-specific confirmation:

```bash
node scripts/sync-local-core-from-cloud.mjs \
  --replace-local-data=aipaths_mission_control_local
```

Replacement mode first locks the closed import set against concurrent writes, then creates and verifies a full custom-format `pg_dump` under:

```text
~/Library/Application Support/AIPaths Mission Control/backups/
```

Only after backup and all preflight checks succeed does it replace the closed dependency set in one transaction. It does not use `TRUNCATE ... CASCADE`. Override the backup directory only together with replacement via `--backup-dir=/absolute/path`. Restore a backup with `pg_restore` into a separately created database and inspect it before any cutover.

### 5. Run locally

```bash
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) and log in.

## Local-only hosting contract

- Mission Control listens on `127.0.0.1:3001` in development and production mode.
- Do not bind it to `0.0.0.0` for normal operation.
- Remote access should use a private network layer such as Tailscale, not direct LAN or public exposure.
- Application and maintenance writes use `MISSION_CONTROL_DATABASE_URL`; they do not silently fall back to Supabase Cloud.

## launchd service (macOS)

Both checked-in plist variants are intentionally aligned to the canonical checkout and explicit local database environment:

```text
ops/macos/com.aipaths.mission-control.plist
ops/macos/com.aipaths.mission-control.local.plist
```

Build before loading the production service:

```bash
npm run build
cp ops/macos/com.aipaths.mission-control.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.aipaths.mission-control 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aipaths.mission-control.plist
launchctl kickstart -k gui/$(id -u)/com.aipaths.mission-control
```

After code changes, rebuild and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.aipaths.mission-control
```

Useful checks:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
launchctl print gui/$(id -u)/com.aipaths.mission-control

tail -n 100 ~/Library/Logs/com.aipaths.mission-control.out.log
tail -n 100 ~/Library/Logs/com.aipaths.mission-control.err.log
```

Current production-like local service facts on the Mac Mini:

- LaunchAgent label: `com.aipaths.mission-control`
- Working directory: `/Users/joaco/openclaw/repos/aipaths-mission-control-live`
- Database: `aipaths_mission_control_local` on `127.0.0.1`
- Start command: `next start -H 127.0.0.1 -p 3001`
- Tunnel target: the service on loopback port `3001`

## Maintenance scripts

Seed the historical repo-hygiene suggestions into local Postgres with:

```bash
npm run suggestions:seed-hygiene
```

The command requires `MISSION_CONTROL_DATABASE_URL`, validates the exact local target, writes `work_items` and `event_log` transactionally, and has no Supabase/cloud fallback.

Run the project tests with:

```bash
npm test
npm run test:youtube-statistics
npm run lint
plutil -lint ops/macos/*.plist
```

`npm test`, `npm run test:loops`, and `npm run test:youtube-statistics` create a
unique disposable PostgreSQL database on an exact loopback address, apply
`ops/local-postgres/schema.sql`, run `node --test` with only the guarded
`MISSION_CONTROL_TEST_DATABASE_URL`, and terminate connections/drop the database
in cleanup. They deliberately remove `MISSION_CONTROL_DATABASE_URL` and refuse
the live `aipaths_mission_control_local` database. To use a non-default local
PostgreSQL role or port, set `MISSION_CONTROL_TEST_ADMIN_URL` to a loopback URL
whose database is `postgres` or `template1`.

## Tech Stack

- **Next.js 16** (App Router, TypeScript)
- **Tailwind CSS** (dark theme)
- **Local Postgres** (Mission Control operational data)
- **Supabase + @supabase/ssr** (auth and explicit bootstrap/integration paths)

## Intel Inbox

Mission Control exposes the strategist review surface at:

- UI: `/intel`
- API: `/api/intel/inbox`

The Intel Inbox reviews enriched market-intelligence items from `intel_items_enriched`, stores analyst decisions in `intel_inbox_reviews`, and promotes selected items directly into `pipeline_items`.
