# 🛰️ AIPaths Mission Control

A dark-themed dashboard for managing AI agents, tasks, cron jobs, memory logs, and the Intel Inbox. Built with Next.js 15, TypeScript, Tailwind CSS, and Supabase.

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/openclaw-io/aipaths-mission-control.git
cd aipaths-mission-control
npm install
```

### 2. Create a Supabase Project

Go to [supabase.com](https://supabase.com) and create a new project.

### 3. Run the SQL Migrations

Open the Supabase SQL Editor and run the migrations in `supabase/migrations/` in order.

High-signal milestones in the current repo:

```text
supabase/migrations/001_create_tables.sql
supabase/migrations/009_memories_vector.sql
supabase/migrations/016_create_strategist_internal_analytics.sql
supabase/migrations/017_retire_agent_memory.sql
supabase/migrations/018_create_ops_youtube_comments.sql
```

`001_create_tables.sql` sets up the base tables. `009_memories_vector.sql` creates the active `memories` table used by the app for journal, strategic, and report entries. `017_retire_agent_memory.sql` records the retirement of the legacy `agent_memory` table, and `018_create_ops_youtube_comments.sql` adds the canonical YouTube comments table used by strategist analytics.

### 4. Configure Environment

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env.local
```

Required variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AGENT_API_KEY`
- `OPENCLAW_GATEWAY_TOKEN`

Optional:
- `DISCORD_TASK_ROUTER_WEBHOOK`

### 5. Create a User

In the Supabase dashboard, go to **Authentication → Users** and create a user with email and password. This will be your login for Mission Control.

### 6. Run the Dev Server

```bash
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) and log in.

## Local-only hosting contract

- Mission Control listens on `127.0.0.1:3001` in both dev and production mode.
- Do not bind it to `0.0.0.0` for normal operation.
- Remote access should happen through a private network layer such as Tailscale, not direct LAN or public exposure.

## launchd service (macOS)

A ready-to-install LaunchAgent lives at:

```text
ops/macos/com.aipaths.mission-control.plist
```

Typical first-time load flow:

```bash
cp ops/macos/com.aipaths.mission-control.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.aipaths.mission-control.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.aipaths.mission-control.plist
launchctl start com.aipaths.mission-control
```

For day-to-day development after code changes, the key command is usually just:

```bash
launchctl kickstart -k gui/$(id -u)/com.aipaths.mission-control
```

That restarts the LaunchAgent already serving Mission Control on `127.0.0.1:3001`.

Useful checks:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
launchctl print gui/$(id -u)/com.aipaths.mission-control | sed -n '1,120p'
tail -n 100 ~/Library/Logs/com.aipaths.mission-control.out.log
tail -n 100 ~/Library/Logs/com.aipaths.mission-control.err.log
```

Current production-like local service facts on the Mac Mini:
- LaunchAgent label: `com.aipaths.mission-control`
- Working directory: `/Users/joaco/Documents/openclaw/repos/aipaths-mission-control-live`
- Start command: `next start -H 127.0.0.1 -p 3001`
- Tunnel target should therefore reflect the app served from port `3001`

## Tech Stack

- **Next.js 15** (App Router, TypeScript)
- **Tailwind CSS** (dark theme)
- **Supabase** (Auth + Postgres)
- **@supabase/ssr** (cookie-based auth)

## Intel Inbox

Mission Control now exposes the strategist review surface at:
- UI: `/intel`
- API: `/api/intel/inbox`

The Intel Inbox reviews enriched market-intelligence items from `intel_items_enriched`, stores analyst decisions in `intel_inbox_reviews`, and promotes selected items directly into `pipeline_items`.
