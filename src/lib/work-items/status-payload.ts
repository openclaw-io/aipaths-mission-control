export function serializeWorkItemStatusPayload(
  status: "in_progress" | "done" | "failed",
  workPayload?: Record<string, unknown> | null,
) {
  const executionAttemptId = typeof workPayload?.execution_attempt_id === "string"
    ? workPayload.execution_attempt_id
    : null;
  return JSON.stringify({
    status,
    ...(executionAttemptId ? { execution_attempt_id: executionAttemptId } : {}),
  });
}
