-- Migration 015: Add model field to agent_tasks for model routing
-- Run in Supabase SQL Editor

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS model text;
-- Values: null (auto-route), 'sonnet', 'opus'
