const CONTROLLED_PAYLOAD_KEYS = new Map([
  ["source_project_id", "source_loop_id"],
  ["source_project_title", "source_loop_title"],
  ["materialized_from_project", "materialized_from_loop"],
  ["project_status_at_materialization", "loop_status_at_materialization"],
  ["superseded_for_project_id", "superseded_for_loop_id"],
]);

const OPEN_PRIMARY_EXECUTION_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);

/**
 * Rewrites only first-level keys owned by the Mission Control domain. Nested and
 * user-authored content is deliberately left untouched.
 */
export function rewriteLegacyLoopPayload(payload) {
  const rewritten = {};
  for (const [key, value] of Object.entries(payload || {})) {
    rewritten[CONTROLLED_PAYLOAD_KEYS.get(key) || key] = value;
  }
  return rewritten;
}

export function rewriteLegacyLoopValue(field, value) {
  if (field === "source_type" && value === "project") return "loop";
  if (field === "event_type" && typeof value === "string" && value.startsWith("project.")) {
    return `loop.${value.slice("project.".length)}`;
  }
  if (field === "actor" && value === "project-planner") return "loop-planner";
  if (field === "actor" && value === "project-execution-materializer") return "loop-execution-materializer";
  return value;
}

export function getLoopStatusForPrimaryExecution(loopStatus, workItemStatus) {
  if (!workItemStatus) return null;
  if (workItemStatus === "done") {
    return ["in_review", "completed"].includes(loopStatus) ? null : "in_review";
  }
  if (OPEN_PRIMARY_EXECUTION_STATUSES.has(workItemStatus)) {
    return loopStatus === "in_progress" ? null : "in_progress";
  }
  return null;
}
