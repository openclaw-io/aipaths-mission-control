-- Migration 024: Retire empty project content/service relation tables
-- Context: projects now use project_work_items for canonical execution linkage.
-- project_pipeline_items and project_services are empty and no longer referenced by active code.
-- Keep project_work_items: it is the active project -> work_items relation table.

begin;

drop table if exists project_pipeline_items;
drop table if exists project_services;

commit;
