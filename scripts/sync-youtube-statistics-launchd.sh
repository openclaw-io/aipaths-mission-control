#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/joaco"

REPO="/Users/joaco/openclaw/repos/aipaths-mission-control-live"
WINDOW="${YOUTUBE_STATISTICS_WINDOW:?YOUTUBE_STATISTICS_WINDOW is required}"
MODE="${YOUTUBE_STATISTICS_SYNC_MODE:-batch}"
LIMIT="${YOUTUBE_STATISTICS_LIMIT:-20}"
OFFSETS="${YOUTUBE_STATISTICS_OFFSETS:-0}"
RETENTION_CURVE="${YOUTUBE_STATISTICS_INCLUDE_RETENTION_CURVE:-false}"
LOCK_DIR="/tmp/aipaths-youtube-statistics-sync-${WINDOW// /-}.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] statistics sync window=$WINDOW already running; exiting"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

cd "$REPO"
if [[ "$MODE" == "batch" ]]; then
  for ONE_WINDOW in $WINDOW; do
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] sync-youtube-statistics-batch start window=$ONE_WINDOW"
    npm run sync:youtube-statistics:batch -- --window="$ONE_WINDOW"
  done
else
  for OFFSET in $OFFSETS; do
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] sync-youtube-statistics start window=$WINDOW limit=$LIMIT offset=$OFFSET retention_curve=$RETENTION_CURVE"
    npm run sync:youtube-statistics -- --window="$WINDOW" --limit="$LIMIT" --offset="$OFFSET" --include-retention-curve="$RETENTION_CURVE"
  done
fi
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] sync-youtube-statistics done window=$WINDOW mode=$MODE"
