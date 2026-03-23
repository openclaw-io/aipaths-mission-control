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

```
supabase/migrations/001_create_tables.sql
```

This creates the `agent_tasks`, `cron_health`, and `agent_memory` tables with RLS policies.

### 4. Configure Environment

Copy the example env file and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase project URL, anon key, and service role key (found in Settings → API).

### 5. Create a User

In the Supabase dashboard, go to **Authentication → Users** and create a new user with email and password. This will be your login for Mission Control.

### 6. Run the Dev Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you'll be redirected to the login page.

## Tech Stack

- **Next.js 15** (App Router, TypeScript)
- **Tailwind CSS** (dark theme)
- **Supabase** (Auth + Postgres)
- **@supabase/ssr** (cookie-based auth)
