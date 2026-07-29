// End-to-end reviewer timing contract. Capability validity begins before package
// preparation and must cover that work, the bounded Hermes call, state.db
// verification, and the completion HTTP request with operational scheduling slack.
export const REVIEW_PACKAGE_PREPARATION_BUDGET_MS = 5 * 60_000;
export const MAX_HERMES_REVIEW_MS = 30 * 60_000;
export const REVIEW_STATE_AND_HTTP_MARGIN_MS = 5 * 60_000;
export const REVIEW_CAPABILITY_TTL_MS = 40 * 60_000;
export const REVIEW_COMPLETION_HTTP_TIMEOUT_MS = 30_000;
