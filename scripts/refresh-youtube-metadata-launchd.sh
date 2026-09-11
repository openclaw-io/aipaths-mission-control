#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/joaco"
export MISSION_CONTROL_DATABASE_URL="${MISSION_CONTROL_DATABASE_URL:-postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local}"
export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-local-dummy-service-role-key}"

REPO="/Users/joaco/Repos/repos/aipaths-mission-control-live"
LOG_DIR="$REPO/logs"
LOCK_DIR="/tmp/aipaths-youtube-metadata-refresh.lock"
LIMIT="${YOUTUBE_METADATA_REFRESH_LIMIT:-100}"
REFRESH_ALL="${YOUTUBE_METADATA_REFRESH_ALL:-0}"

mkdir -p "$LOG_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] metadata refresh already running; exiting"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

cd "$REPO"
if [[ "$REFRESH_ALL" == "1" || "$REFRESH_ALL" == "true" || "$LIMIT" == "all" ]]; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] refresh-youtube-metadata start all"
  npm run refresh:youtube-metadata -- --all
else
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] refresh-youtube-metadata start limit=$LIMIT"
  npm run refresh:youtube-metadata -- --limit="$LIMIT"
fi
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] refresh-youtube-metadata done"
