-- Migration 021: Retire legacy agent_tasks
-- Context: Mission Control now uses work_items as the canonical execution queue.
-- 2026-04-27: Legacy /tasks runtime and APIs were removed; active backlog and final done rows were exported before cleanup.

begin;

-- Keep historical log rows but remove their legacy foreign-key dependency.
alter table if exists activity_log
  drop constraint if exists activity_log_task_id_fkey;

alter table if exists usage_logs
  drop constraint if exists usage_logs_task_id_fkey;

-- Remove legacy task automation tied to agent_tasks.
drop trigger if exists trg_cascade_task_completion on agent_tasks;
drop function if exists cascade_task_completion();

-- Final retirement of the old task queue table.
drop table if exists agent_tasks;

commit;
