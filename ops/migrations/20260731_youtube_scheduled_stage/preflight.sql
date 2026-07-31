-- Read-only preflight. Run separately in local and cloud Mission Control.

select status, count(*) as video_count
from public.pipeline_items
where pipeline_type = 'video'
group by status
order by status;

-- Every legacy Learning representation; forward.sql handles the union deliberately.
select id, title, status, published_at, current_url, scheduled_for,
       metadata #>> '{youtube_v0,stage}' as metadata_stage
from public.pipeline_items
where pipeline_type = 'video'
  and (status = 'learning' or metadata #>> '{youtube_v0,stage}' = 'learning')
order by id;

-- Every active scheduled launch; all must have scheduled_for before forward.sql can run.
select p.id, p.title, p.status, p.scheduled_for, p.published_at, p.current_url,
       p.metadata #>> '{youtube_v0,stage}' as metadata_stage,
       p.metadata #>> '{launch_package,status}' as launch_status,
       p.metadata #>> '{launch_package,launch_generation}' as launch_generation,
       p.metadata #>> '{launch_package,activation_work_item_id}' as activation_work_item_id,
       (select count(*)
          from public.work_items w
         where w.payload ->> 'source_video_pipeline_item_id' = p.id::text
           and w.payload ->> 'relation_type' = 'video_launch_activate'
           and w.status not in ('done','failed','canceled','cancelled')) as open_activation_count,
       case
         when p.scheduled_for is null then 'BLOCKER_MISSING_SCHEDULED_FOR'
         when p.metadata #>> '{launch_package,launch_generation}' is null
           or p.metadata #>> '{launch_package,activation_work_item_id}' is null
           or p.metadata #>> '{launch_package,publish_at}' is null
           then 'BLOCKER_RECONCILE_LAUNCH_PACKAGE'
         when (select count(*)
                 from public.work_items w
                where w.payload ->> 'source_video_pipeline_item_id' = p.id::text
                  and w.payload ->> 'relation_type' = 'video_launch_activate'
                  and w.status not in ('done','failed','canceled','cancelled')) <> 1
           then 'BLOCKER_OPEN_ACTIVATION_CARDINALITY'
         when not exists (
           select 1
             from public.work_items w
            where w.id::text = p.metadata #>> '{launch_package,activation_work_item_id}'
              and w.status not in ('done','failed','canceled','cancelled')
              and w.source_type = 'pipeline_item'
              and w.source_id = p.id::text
              and w.payload ->> 'trigger' = 'youtube_launch_package_v1'
              and w.payload ->> 'action' = 'video_launch_activate'
              and w.payload ->> 'pipeline_type' = 'video'
              and w.payload ->> 'pipeline_item_id' = p.id::text
              and w.payload ->> 'source_video_pipeline_item_id' = p.id::text
              and w.payload ->> 'relation_type' = 'video_launch_activate'
              and w.payload ->> 'launch_generation' = p.metadata #>> '{launch_package,launch_generation}'
              and w.payload ->> 'publish_at' = p.metadata #>> '{launch_package,publish_at}'
              and exists (
                select 1 from public.pipeline_work_map pwm
                 where pwm.pipeline_item_id = p.id
                   and pwm.work_item_id = w.id
                   and pwm.relation_type = 'followup'
              )
         ) then 'BLOCKER_ACTIVATION_IDENTITY'
         when (p.metadata #>> '{launch_package,publish_at}')::timestamptz <> p.scheduled_for
           then 'BLOCKER_PUBLISH_AT_MISMATCH'
         else 'ready'
       end as migration_readiness
from public.pipeline_items p
where p.pipeline_type = 'video'
  and p.published_at is null
  and p.metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
  and p.metadata #>> '{launch_package,status}' = 'scheduled'
order by p.scheduled_for nulls first, p.id;

-- Fail closed after the diagnostic rows above: the file cannot report success with a blocker.
do $$
begin
  if to_regclass('mission_control_migration_backup.youtube_stage_20260731') is not null then
    raise exception 'Existing private YouTube stage backup requires investigation before rerun';
  end if;

  if exists (
    select 1
      from public.pipeline_items p
     where p.pipeline_type = 'video'
       and p.published_at is null
       and p.metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
       and p.metadata #>> '{launch_package,status}' = 'scheduled'
       and (p.scheduled_for is null
         or p.metadata #>> '{launch_package,launch_generation}' is null
         or p.metadata #>> '{launch_package,activation_work_item_id}' is null
         or p.metadata #>> '{launch_package,publish_at}' is null
         or (p.metadata #>> '{launch_package,publish_at}')::timestamptz <> p.scheduled_for
         or (select count(*)
               from public.work_items w
              where w.payload ->> 'source_video_pipeline_item_id' = p.id::text
                and w.payload ->> 'relation_type' = 'video_launch_activate'
                and w.status not in ('done','failed','canceled','cancelled')) <> 1
         or not exists (
           select 1
             from public.work_items w
            where w.id::text = p.metadata #>> '{launch_package,activation_work_item_id}'
              and w.status not in ('done','failed','canceled','cancelled')
              and w.source_type = 'pipeline_item'
              and w.source_id = p.id::text
              and w.payload ->> 'trigger' = 'youtube_launch_package_v1'
              and w.payload ->> 'action' = 'video_launch_activate'
              and w.payload ->> 'pipeline_type' = 'video'
              and w.payload ->> 'pipeline_item_id' = p.id::text
              and w.payload ->> 'source_video_pipeline_item_id' = p.id::text
              and w.payload ->> 'relation_type' = 'video_launch_activate'
              and w.payload ->> 'launch_generation' = p.metadata #>> '{launch_package,launch_generation}'
              and w.payload ->> 'publish_at' = p.metadata #>> '{launch_package,publish_at}'
              and exists (
                select 1
                  from public.pipeline_work_map pwm
                 where pwm.pipeline_item_id = p.id
                   and pwm.work_item_id = w.id
                   and pwm.relation_type = 'followup'
              )
         ))
  ) then
    raise exception 'YouTube Scheduled preflight found one or more BLOCKER rows';
  end if;
end $$;

select to_regclass('mission_control_migration_backup.youtube_stage_20260731') as existing_backup_table;
