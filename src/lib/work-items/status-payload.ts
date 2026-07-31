export function serializeWorkItemStatusPayload(
  status: "in_progress" | "done" | "failed",
  workPayload?: Record<string, unknown> | null,
) {
  const attemptId = typeof workPayload?.execution_attempt_id === "string"
    ? workPayload.execution_attempt_id.trim()
    : "";
  return JSON.stringify(attemptId ? { status, execution_attempt_id: attemptId } : { status });
}
