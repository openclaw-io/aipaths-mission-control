begin;

-- Prevent a writer from changing a target between provenance validation and restore.
lock table public.pipeline_items in share row exclusive mode;

-- One-shot, provenance-safe rollback. Refuse if any migrated row changed after cutover.
do $$
begin
  if to_regclass('mission_control_migration_backup.youtube_stage_20260731') is null then
    raise exception 'Missing private YouTube stage backup; refusing unscoped rollback';
  end if;

  if (select count(*) from mission_control_migration_backup.youtube_stage_20260731)
     <> (select count(*)
           from mission_control_migration_backup.youtube_stage_20260731 as backup
           join public.pipeline_items as target using (id)) then
    raise exception 'A migrated YouTube row is missing after cutover; refusing destructive rollback';
  end if;

  if exists (
    select 1
    from mission_control_migration_backup.youtube_stage_20260731 as backup
    join public.pipeline_items as target using (id)
    where target.updated_at is distinct from backup.cutover_applied_at
       or case
            when backup.published_at is null
             and backup.metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
             and backup.metadata #>> '{launch_package,status}' = 'scheduled'
              then target.status is distinct from 'scheduled'
                or target.current_url is not null
                or target.metadata #>> '{youtube_v0,stage}' is distinct from 'scheduled'
            else target.status is distinct from 'published'
              or target.metadata #>> '{youtube_v0,stage}' is distinct from 'published'
          end
  ) then
    raise exception 'A migrated YouTube row changed after cutover; refusing destructive rollback';
  end if;
end $$;

update public.pipeline_items as target
set status = backup.status,
    current_url = backup.current_url,
    metadata = backup.metadata,
    updated_at = backup.updated_at
from mission_control_migration_backup.youtube_stage_20260731 as backup
where target.id = backup.id
  and target.updated_at = backup.cutover_applied_at;

do $$
begin
  if (select count(*) from mission_control_migration_backup.youtube_stage_20260731)
     <> (select count(*)
           from mission_control_migration_backup.youtube_stage_20260731 as backup
           join public.pipeline_items as target using (id)
          where target.status is not distinct from backup.status
            and target.current_url is not distinct from backup.current_url
            and target.metadata is not distinct from backup.metadata
            and target.updated_at is not distinct from backup.updated_at) then
    raise exception 'YouTube rollback did not restore every backed-up row exactly';
  end if;
end $$;

commit;

-- Keep the private backup until rollback verification is complete.
select target.id, target.title, target.status, target.scheduled_for, target.published_at, target.current_url,
       target.metadata #>> '{youtube_v0,stage}' as metadata_stage
from public.pipeline_items as target
join mission_control_migration_backup.youtube_stage_20260731 as backup using (id)
order by target.id;
