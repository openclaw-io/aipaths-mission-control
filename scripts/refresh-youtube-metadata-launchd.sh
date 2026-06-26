#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/joaco"

REPO="/Users/joaco/openclaw/repos/aipaths-mission-control-live"
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
