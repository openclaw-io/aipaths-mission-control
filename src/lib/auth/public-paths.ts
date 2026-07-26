const EXACT_PUBLIC_PATHS = new Set([
  "/login",
  "/api/healthz",
  "/api/work-items/notify",
  "/api/loops/materialize-queued",
  "/api/loops/plan-pending",
  "/api/youtube/launch-package",
]);

export function isPublicPath(pathname: string) {
  if (EXACT_PUBLIC_PATHS.has(pathname)) return true;

  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
    pathname.startsWith("/api/agent/")
  );
}
