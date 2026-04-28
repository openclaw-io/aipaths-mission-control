# Blog and Guide Publication Flow

Mission Control uses pipeline items plus Work Queue publish tasks to keep content review, localization, scheduling, and publication auditable.

## Blogs

Current blog flow:

```text
ready_for_review -> localizing -> final_check -> scheduled -> live
```

Key rules:

- `approve` from `ready_for_review` creates/uses a Content work item with `action = localize_blog_to_en`.
- When Content completes localization, blogs move to `final_check`, not directly to `scheduled`.
- `final_check` is the human approval gate for:
  - approved Spanish draft
  - English localization
  - hero/thumbnail candidate
- `approve_final` must create or update a Dev publish work item:
  - `action = publish_blog`
  - `relation_type = publish`
  - `status = ready`
  - concrete `scheduled_for`
- If no explicit schedule exists, Mission Control allocates the next free publication slot from the shared content schedule.
- Default publication slots are weekdays at 10:00, 15:00, and 18:00 Europe/London during BST (`09:00`, `14:00`, `17:00` UTC).
- Publish work items must carry `payload.schedule_kind = "publication"` so the Work Queue calendar can distinguish editorial publication dates from operational retry delays.
- Scheduled blog cards should show the thumbnail and publish task state.

## Guides

Current guide flow:

```text
ready_for_review -> localizing -> scheduled -> live
```

Guides do not currently use the blog `final_check` gate. The important hardening rule is scheduling integrity:

- Completion of `localize_guide_to_en` moves the guide to `scheduled`.
- It must create a Dev publish work item:
  - `action = publish_guide`
  - `relation_type = publish`
  - `status = ready`
  - concrete `scheduled_for`
- If no explicit schedule exists, Mission Control allocates the next free publication slot from the shared content schedule.
- Publish work items must carry `payload.schedule_kind = "publication"`.
- Scheduled guide cards should show publish task state and queued time.

## Publish work item contract

Publish work items are the handoff to Dev. They should not be hidden drafts once the pipeline item is scheduled.

Expected shape:

```ts
{
  source_type: "service" | "pipeline_item",
  source_id: pipelineItemId,
  status: "ready",
  scheduled_for: string, // ISO timestamp
  owner_agent: "dev",
  target_agent_id: "dev",
  payload: {
    pipeline_type: "blog" | "guide" | "doc",
    pipeline_item_id: pipelineItemId,
    relation_type: "publish",
    action: "publish_blog" | "publish_guide",
    schedule_kind: "publication"
  }
}
```

Also link via `pipeline_work_map` with `relation_type = publish` when possible.

## Work Queue calendar boundary

`work_items.scheduled_for` can mean different things:

- editorial publication date
- recurring operational run date
- temporary dispatch retry delay

The calendar should not treat all scheduled work as editorial content. Publication cards are identified through `payload.schedule_kind = "publication"`, `relation_type = "publish"`, or a publish action. Dispatch retry delays should use `payload.schedule_kind = "dispatch_retry"` and stay out of the editorial/calendar surface.

## Blog image handoff

Final website standard remains the content repo path:

```text
aipaths-academy-content/public/images/blogs/[blog-folder]/hero.png
```

Blog frontmatter should use the GitHub raw URL for that image as `coverImage`.

Mission Control may store temporary local/OpenClaw media paths in `metadata.hero_image` for review, but publish work should copy the approved asset to the content repo standard path.

## Known hardening follow-ups

See Systems plan:

```text
/Users/joaco/Documents/openclaw/director-systems/plans/BLOG-FINAL-PACKAGE-HARDENING-PLAN-2026-04-28.md
```

Open follow-ups include:

- canonical `metadata.final_package`
- validation gate before blog `final_check`
- image generation logs/cost tracking
- daily/per-blog image generation caps
- cleanup of legacy thumbnail aliases after canonical contract is live
