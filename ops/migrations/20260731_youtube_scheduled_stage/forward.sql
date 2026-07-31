begin;

-- Private owner-only backup. Fail closed on rerun because CREATE TABLE is not IF NOT EXISTS.
create schema if not exists mission_control_migration_backup;
revoke all on schema mission_control_migration_backup from public;

create table mission_control_migration_backup.youtube_stage_20260731 as
select p.*, now() as cutover_applied_at
from public.pipeline_items as p
where p.pipeline_type = 'video'
  and (
    p.status = 'learning'
    or p.metadata #>> '{youtube_v0,stage}' = 'learning'
    or (
      p.published_at is null
      and p.metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
      and p.metadata #>> '{launch_package,status}' = 'scheduled'
    )
  );

alter table mission_control_migration_backup.youtube_stage_20260731 add primary key (id);
revoke all on table mission_control_migration_backup.youtube_stage_20260731 from public;

-- An active launch without a date is not safely schedulable.
do $$
begin
  if exists (
    select 1 from public.pipeline_items
    where pipeline_type = 'video'
      and published_at is null
      and metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
      and metadata #>> '{launch_package,status}' = 'scheduled'
      and (scheduled_for is null
        or metadata #>> '{launch_package,launch_generation}' is null
        or metadata #>> '{launch_package,activation_work_item_id}' is null
        or metadata #>> '{launch_package,publish_at}' is null
        or (metadata #>> '{launch_package,publish_at}')::timestamptz <> scheduled_for
        or (select count(*)
              from public.work_items w
             where w.payload ->> 'source_video_pipeline_item_id' = pipeline_items.id::text
               and w.payload ->> 'relation_type' = 'video_launch_activate'
               and w.status not in ('done','failed','canceled','cancelled')) <> 1
        or not exists (
          select 1
            from public.work_items w
           where w.id::text = pipeline_items.metadata #>> '{launch_package,activation_work_item_id}'
             and w.status not in ('done','failed','canceled','cancelled')
             and w.source_type = 'pipeline_item'
             and w.source_id = pipeline_items.id::text
             and w.payload ->> 'trigger' = 'youtube_launch_package_v1'
             and w.payload ->> 'action' = 'video_launch_activate'
             and w.payload ->> 'pipeline_type' = 'video'
             and w.payload ->> 'pipeline_item_id' = pipeline_items.id::text
             and w.payload ->> 'source_video_pipeline_item_id' = pipeline_items.id::text
             and w.payload ->> 'relation_type' = 'video_launch_activate'
             and w.payload ->> 'launch_generation' = pipeline_items.metadata #>> '{launch_package,launch_generation}'
             and w.payload ->> 'publish_at' = pipeline_items.metadata #>> '{launch_package,publish_at}'
             and exists (
               select 1 from public.pipeline_work_map pwm
                where pwm.pipeline_item_id = pipeline_items.id
                  and pwm.work_item_id = w.id
                  and pwm.relation_type = 'followup'
             )
        ))
  ) then
    raise exception 'Active YouTube launch package requires exactly one valid open activation with matching stored ID, generation, publish_at, parent source and followup mapping';
  end if;
end $$;

-- Retire Learning only as a workflow stage; preserve publication facts and postmortem metadata.
update public.pipeline_items
set status = 'published',
    metadata = jsonb_set(
      coalesce(metadata, '{}'::jsonb),
      '{youtube_v0}',
      coalesce(metadata -> 'youtube_v0', '{}'::jsonb) || '{"stage":"published"}'::jsonb,
      true
    ),
    updated_at = now()
where pipeline_type = 'video'
  and (status = 'learning' or metadata #>> '{youtube_v0,stage}' = 'learning');

-- Converge every active, nonpublished launch package.
update public.pipeline_items
set status = 'scheduled',
    current_url = null,
    metadata = jsonb_set(
      coalesce(metadata, '{}'::jsonb),
      '{youtube_v0}',
      coalesce(metadata -> 'youtube_v0', '{}'::jsonb) || '{"stage":"scheduled"}'::jsonb,
      true
    ),
    updated_at = now()
where pipeline_type = 'video'
  and published_at is null
  and scheduled_for is not null
  and metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
  and metadata #>> '{launch_package,status}' = 'scheduled';

do $$
begin
  if exists (
    select 1 from public.pipeline_items
    where pipeline_type = 'video'
      and (status = 'learning' or metadata #>> '{youtube_v0,stage}' = 'learning')
  ) then
    raise exception 'YouTube Learning workflow rows remain';
  end if;

  if exists (
    select 1 from public.pipeline_items
    where pipeline_type = 'video'
      and published_at is null
      and metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
      and metadata #>> '{launch_package,status}' = 'scheduled'
      and (scheduled_for is null
        or status <> 'scheduled'
        or current_url is not null
        or metadata #>> '{youtube_v0,stage}' <> 'scheduled'
        or metadata #>> '{launch_package,launch_generation}' is null
        or metadata #>> '{launch_package,activation_work_item_id}' is null
        or metadata #>> '{launch_package,publish_at}' is null
        or (metadata #>> '{launch_package,publish_at}')::timestamptz <> scheduled_for
        or (select count(*)
              from public.work_items w
             where w.payload ->> 'source_video_pipeline_item_id' = pipeline_items.id::text
               and w.payload ->> 'relation_type' = 'video_launch_activate'
               and w.status not in ('done','failed','canceled','cancelled')) <> 1
        or not exists (
          select 1 from public.work_items w
           where w.id::text = pipeline_items.metadata #>> '{launch_package,activation_work_item_id}'
             and w.status not in ('done','failed','canceled','cancelled')
             and w.source_type = 'pipeline_item'
             and w.source_id = pipeline_items.id::text
             and w.payload ->> 'trigger' = 'youtube_launch_package_v1'
             and w.payload ->> 'action' = 'video_launch_activate'
             and w.payload ->> 'pipeline_type' = 'video'
             and w.payload ->> 'pipeline_item_id' = pipeline_items.id::text
             and w.payload ->> 'source_video_pipeline_item_id' = pipeline_items.id::text
             and w.payload ->> 'relation_type' = 'video_launch_activate'
             and w.payload ->> 'launch_generation' = pipeline_items.metadata #>> '{launch_package,launch_generation}'
             and w.payload ->> 'publish_at' = pipeline_items.metadata #>> '{launch_package,publish_at}'
             and exists (
               select 1 from public.pipeline_work_map pwm
                where pwm.pipeline_item_id = pipeline_items.id
                  and pwm.work_item_id = w.id
                  and pwm.relation_type = 'followup'
             )
        ))
  ) then
    raise exception 'Scheduled YouTube launch rows did not converge';
  end if;
end $$;

commit;

select status, count(*) as video_count
from public.pipeline_items
where pipeline_type = 'video'
group by status
order by status;
