export type JsonRecord = Record<string, unknown>;

export const SCHEDULED_LAUNCH_RETRY_CONTRACT = "scheduled_launch_v2_retry_v1" as const;
export const DEFAULT_SCHEDULED_LAUNCH_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
export const DEFAULT_SCHEDULED_LAUNCH_RETRYABLE_FAILURE_CLASSES = [
  "runtime_unavailable",
  "provider_timeout",
  "transient_network",
] as const;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function positiveDelays(value: unknown) {
  if (!Array.isArray(value)) return [...DEFAULT_SCHEDULED_LAUNCH_RETRY_DELAYS_MINUTES];
  const delays = value
    .map(Number)
    .filter((delay) => Number.isSafeInteger(delay) && delay > 0 && delay <= 24 * 60);
  return delays.length ? delays : [...DEFAULT_SCHEDULED_LAUNCH_RETRY_DELAYS_MINUTES];
}

function retryableClasses(value: unknown) {
  if (!Array.isArray(value)) return new Set<string>(DEFAULT_SCHEDULED_LAUNCH_RETRYABLE_FAILURE_CLASSES);
  const classes = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return new Set(classes.length ? classes : DEFAULT_SCHEDULED_LAUNCH_RETRYABLE_FAILURE_CLASSES);
}

function validNow(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("scheduled_launch_retry_now_invalid");
  return date;
}

function priorAttempt(payload: JsonRecord) {
  const state = toRecord(payload.runtime_retry_state);
  const attempt = Number(state.attempt);
  return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
}

export function nextScheduledLaunchRetryTransition(
  sourcePayload: JsonRecord,
  input: { now: string | Date; failureClass: string; error: string },
) {
  const payload = { ...sourcePayload };
  const policy = toRecord(payload.retry_policy);
  const delays = positiveDelays(policy.retryable_delays_minutes);
  const classes = retryableClasses(policy.retryable_failure_classes);
  const now = validNow(input.now);
  const attempt = priorAttempt(payload) + 1;
  const retryableFailure = payload.runtime_retry_contract === SCHEDULED_LAUNCH_RETRY_CONTRACT
    && classes.has(input.failureClass);
  const delayMinutes = retryableFailure && attempt <= delays.length ? delays[attempt - 1] : null;
  const attemptedAt = now.toISOString();
  const history = Array.isArray(toRecord(payload.runtime_retry_state).history)
    ? [...toRecord(payload.runtime_retry_state).history as unknown[]]
    : [];
  history.push({
    attempt,
    attempted_at: attemptedAt,
    failure_class: input.failureClass,
    error: input.error,
    delay_minutes: delayMinutes,
  });

  if (delayMinutes !== null) {
    const scheduledFor = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
    return {
      retryable: true,
      attempt,
      delayMinutes,
      status: "ready" as const,
      scheduledFor,
      payload: {
        ...payload,
        dispatch_state: "retry_scheduled",
        dispatch_failure_class: input.failureClass,
        dispatch_failure_reason: input.error,
        dispatch_last_failed_at: attemptedAt,
        dead_letter_reason: null,
        dead_lettered_at: null,
        runtime_retry_state: {
          attempt,
          last_attempted_at: attemptedAt,
          last_failure_class: input.failureClass,
          last_error: input.error,
          next_retry_at: scheduledFor,
          exhausted: false,
          history,
        },
      },
    };
  }

  const nonretryable = !retryableFailure;
  return {
    retryable: false,
    attempt,
    delayMinutes: null,
    status: "failed" as const,
    scheduledFor: null,
    payload: {
      ...payload,
      dispatch_state: "dead_lettered",
      dispatch_failure_class: input.failureClass,
      dispatch_failure_reason: input.error,
      dispatch_last_failed_at: attemptedAt,
      dead_letter_reason: nonretryable
        ? `scheduled_launch_nonretryable_${input.failureClass}`
        : "scheduled_launch_retries_exhausted",
      dead_lettered_at: attemptedAt,
      remediation: nonretryable
        ? "Resolve the nonretryable failure, verify delivery was not attempted, then manually requeue."
        : "Inspect the repeated runtime failure, verify delivery was not attempted, then manually requeue.",
      runtime_retry_state: {
        attempt,
        last_attempted_at: attemptedAt,
        last_failure_class: input.failureClass,
        last_error: input.error,
        next_retry_at: null,
        exhausted: true,
        history,
      },
    },
  };
}

export function buildScheduledLaunchGateBlockedTransition(
  sourcePayload: JsonRecord,
  input: { now: string | Date; failures: string[]; remediation: string },
) {
  const now = validNow(input.now).toISOString();
  const failures = input.failures.filter((failure) => typeof failure === "string" && failure.length > 0);
  return {
    retryable: false,
    attempt: priorAttempt(sourcePayload),
    delayMinutes: null,
    status: "blocked" as const,
    scheduledFor: null,
    payload: {
      ...sourcePayload,
      dispatch_state: "blocked_launch_gate",
      dispatch_failure_class: "nonretryable_gate",
      dispatch_failure_reason: failures.join(",") || "scheduled_launch_gate_blocked",
      dead_letter_reason: failures[0] || "scheduled_launch_gate_blocked",
      dead_lettered_at: now,
      remediation: input.remediation,
      launch_gate_failures: failures,
    },
  };
}
