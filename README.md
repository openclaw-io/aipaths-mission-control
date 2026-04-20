# 🛰️ AIPaths Mission Control

A dark-themed dashboard for managing AI agents, tasks, cron jobs, and memory logs. Built with Next.js 15, TypeScript, Tailwind CSS, and Supabase.

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/openclaw-io/aipaths-mission-control.git
cd aipaths-mission-control
npm install
```

### 2. Create a Supabase Project

Go to [supabase.com](https://supabase.com) and create a new project.

### 3. Run the SQL Migration

Open the Supabase SQL Editor and run the contents of:

```text
supabase/migrations/001_create_tables.sql
```

This creates the base Mission Control tables.

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

Typical flow:

```bash
cp ops/macos/com.aipaths.mission-control.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.aipaths.mission-control.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.aipaths.mission-control.plist
launchctl start com.aipaths.mission-control
```

## Tech Stack

- **Next.js 15** (App Router, TypeScript)
- **Tailwind CSS** (dark theme)
- **Supabase** (Auth + Postgres)
- **@supabase/ssr** (cookie-based auth)
