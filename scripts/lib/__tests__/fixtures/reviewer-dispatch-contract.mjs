export const REVIEWER_DISPATCH_CONTRACT = Object.freeze({
  executionId: "00000000-0000-4000-8000-000000000404",
  packageSha256: "a".repeat(64),
  cases: Object.freeze({
    running: Object.freeze({
      result: Object.freeze({ ok: true, already_running: false, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", package_sha256: "a".repeat(64), status: "running" }),
      status: 202,
      body: Object.freeze({ ok: true, state_claimed: true, started: true,
        execution_id: "00000000-0000-4000-8000-000000000404", status: "running" }),
    }),
    fastSucceeded: Object.freeze({
      result: Object.freeze({ ok: true, already_running: false, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", package_sha256: "a".repeat(64), status: "succeeded" }),
      status: 202,
      body: Object.freeze({ ok: true, state_claimed: true, started: true,
        execution_id: "00000000-0000-4000-8000-000000000404", status: "succeeded" }),
    }),
    duplicate: Object.freeze({
      result: Object.freeze({ ok: true, already_running: true, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", status: "running" }),
      status: 409,
      body: Object.freeze({ ok: true, already_running: true, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", status: "running" }),
    }),
    claimedTerminal: Object.freeze({
      result: Object.freeze({ ok: true, already_running: false, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", package_sha256: "a".repeat(64), status: "failed" }),
      status: 500,
      body: Object.freeze({ ok: false, state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404", error: "reviewer_execution_failed" }),
    }),
    postClaimSpawn: Object.freeze({
      error: "reviewer_spawn_failed:spawn_test_failure",
      status: 500,
      body: Object.freeze({ error: "reviewer_spawn_failed:spawn_test_failure", state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404" }),
    }),
    postClaimPid: Object.freeze({
      error: "reviewer_pid_persistence_failed:pid_test_failure",
      status: 500,
      body: Object.freeze({ error: "reviewer_pid_persistence_failed:pid_test_failure", state_claimed: true,
        execution_id: "00000000-0000-4000-8000-000000000404" }),
    }),
    preClaimRejection: Object.freeze({
      error: "invalid_review_work_item_id",
      status: 400,
      body: Object.freeze({ error: "invalid_review_work_item_id", state_claimed: false }),
    }),
    preClaimRelation: Object.freeze({
      error: "isolated_review_relation_not_found_or_ambiguous",
      status: 404,
      body: Object.freeze({ error: "isolated_review_relation_not_found_or_ambiguous", state_claimed: false }),
    }),
    preClaimIdentity: Object.freeze({
      error: "isolated_review_identity_conflict",
      status: 409,
      body: Object.freeze({ error: "isolated_review_identity_conflict", state_claimed: false }),
    }),
    preClaimState: Object.freeze({
      error: "isolated_review_dispatch_state_conflict",
      status: 409,
      body: Object.freeze({ error: "isolated_review_dispatch_state_conflict", state_claimed: false }),
    }),
    ambiguousCommit: Object.freeze({
      error: "ambiguous_commit_outcome",
      status: 500,
      body: Object.freeze({ error: "ambiguous_commit_outcome" }),
    }),
  }),
});
