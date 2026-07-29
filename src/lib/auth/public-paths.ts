const EXACT_PUBLIC_PATHS = new Set([
  "/login",
  "/api/healthz",
  "/api/work-items/notify",
  "/api/loops/materialize-queued",
  "/api/loops/plan-pending",
  "/api/youtube/launch-package",
  "/api/reviewer/dispatch",
  "/api/reviewer/reconcile",
]);

const REVIEWER_COMPLETE_PATH = /^\/api\/reviewer\/executions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/complete$/i;

export function isPublicPath(pathname: string) {
  if (EXACT_PUBLIC_PATHS.has(pathname) || REVIEWER_COMPLETE_PATH.test(pathname)) return true;

  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
    pathname.startsWith("/api/agent/")
  );
}
