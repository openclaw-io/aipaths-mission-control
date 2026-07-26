import pg from 'pg';

const { Pool } = pg;

export function getMissionControlDatabaseUrl(env = {}) {
  return process.env.MISSION_CONTROL_DATABASE_URL || env.MISSION_CONTROL_DATABASE_URL || '';
}

export function createMissionControlDb({ env = {}, envPath = '.env.local' } = {}) {
  const databaseUrl = getMissionControlDatabaseUrl(env);
  if (databaseUrl) return createPostgresMissionControlDb(databaseUrl);
  throw new Error(`Missing MISSION_CONTROL_DATABASE_URL in ${envPath}`);
}

function createPostgresMissionControlDb(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
  return {
    kind: 'postgres',
    description: 'local Postgres via MISSION_CONTROL_DATABASE_URL',
    async close() {
      await pool.end();
    },
    async createPipelineRun(options) {
      const result = await pool.query(
        `insert into pipeline_runs (run_type, status, source_system, metadata_json)
         values ($1, $2, $3, $4)
         returning id`,
        [
          'sync:youtube-statistics',
          'running',
          'youtube_mcp',
          {
            windows: options.windows,
            video_type: options.videoType,
            limit: options.limit,
            offset: options.offset,
            include_retention_curve: options.includeRetentionCurve,
          },
        ],
      );
      return result.rows[0].id;
    },
    async finishPipelineRun(runId, patch) {
      await pool.query(
        `update pipeline_runs
         set status = $1,
             rows_read = $2,
             rows_written = $3,
             error_summary = $4,
             finished_at = $5
         where id = $6`,
        [
          patch.status,
          patch.rows_read ?? 0,
          patch.rows_written ?? 0,
          patch.error_summary ?? null,
          new Date().toISOString(),
          runId,
        ],
      );
    },
    async loadOwnedVideoRowsByIds(ids) {
      if (!ids.length) return [];
      const result = await pool.query(
        `select academy_video_id, video_kind, is_published, metadata_json
         from ops_owned_videos
         where academy_video_id = any($1::text[])`,
        [ids],
      );
      return result.rows;
    },
    async upsertOwnedVideoRows(rows) {
      if (!rows.length) return;
      await bulkInsertOnConflict(pool, {
        table: 'ops_owned_videos',
        columns: [
          'academy_video_id',
          'platform',
          'platform_video_id',
          'title',
          'published_at',
          'video_kind',
          'is_published',
          'metadata_json',
          'synced_at',
        ],
        rows,
        conflictTarget: 'academy_video_id',
        updateColumns: [
          'platform',
          'platform_video_id',
          'title',
          'published_at',
          'video_kind',
          'is_published',
          'metadata_json',
          'synced_at',
        ],
      });
    },
    async upsertSnapshotRows(rows) {
      if (!rows.length) return;
      await bulkInsertOnConflict(pool, {
        table: 'ops_youtube_video_learning_snapshots',
        columns: [
          'run_id',
          'academy_video_id',
          'window_key',
          'window_start_date',
          'window_end_date',
          'views',
          'impressions',
          'yt_ctr',
          'avg_view_duration_seconds',
          'avg_percent_viewed',
          'retention_30s',
          'retention_50pct',
          'retention_75pct',
          'watch_time_minutes',
          'subscribers_gained',
          'traffic_source_top',
          'launch_day_impressions',
          'launch_day_yt_ctr',
          'first_7d_impressions',
          'first_7d_yt_ctr',
          'first_7d_reach_days_covered',
          'source_freshness_json',
          'raw_metrics_json',
          'computed_at',
          'updated_at',
        ],
        rows,
        conflictTarget: 'academy_video_id, window_key',
        updateColumns: [
          'run_id',
          'window_start_date',
          'window_end_date',
          'views',
          'impressions',
          'yt_ctr',
          'avg_view_duration_seconds',
          'avg_percent_viewed',
          'retention_30s',
          'retention_50pct',
          'retention_75pct',
          'watch_time_minutes',
          'subscribers_gained',
          'traffic_source_top',
          'launch_day_impressions',
          'launch_day_yt_ctr',
          'first_7d_impressions',
          'first_7d_yt_ctr',
          'first_7d_reach_days_covered',
          'source_freshness_json',
          'raw_metrics_json',
          'computed_at',
          'updated_at',
        ],
      });
    },
    async loadOwnedVideosForMetadata({ ids = [], includeShorts = true, limit = null } = {}) {
      const clauses = ['platform = $1'];
      const values = ['youtube'];
      if (ids.length) {
        values.push(ids);
        clauses.push(`academy_video_id = any($${values.length}::text[])`);
      }
      if (!includeShorts) {
        values.push('longform');
        clauses.push(`video_kind = $${values.length}`);
      }
      let sql = `select academy_video_id, title, video_kind, is_published, metadata_json
                 from ops_owned_videos
                 where ${clauses.join(' and ')}
                 order by published_at desc nulls last`;
      if (limit && !ids.length) {
        values.push(limit);
        sql += ` limit $${values.length}`;
      }
      const result = await pool.query(sql, values);
      return result.rows;
    },
    async updateOwnedVideoMetadata({ academyVideoId, title, videoKind, isPublished, metadata, syncedAt }) {
      await pool.query(
        `update ops_owned_videos
         set title = $1,
             video_kind = $2,
             is_published = $3,
             metadata_json = $4,
             synced_at = $5
         where academy_video_id = $6`,
        [title, videoKind, isPublished, metadata, syncedAt, academyVideoId],
      );
    },
    async loadOwnedVideosForStatisticsBatch() {
      const result = await pool.query(
        `select academy_video_id, title, published_at::text as published_at, video_kind, is_published, metadata_json
         from ops_owned_videos
         where video_kind = $1
         order by published_at desc`,
        ['longform'],
      );
      return result.rows;
    },
    async loadExistingSnapshots(videoIds) {
      if (!videoIds.length) return [];
      const result = await pool.query(
        `select *
         from ops_youtube_video_learning_snapshots
         where academy_video_id = any($1::text[])`,
        [videoIds],
      );
      return result.rows;
    },
  };
}

async function bulkInsertOnConflict(pool, { table, columns, rows, conflictTarget, updateColumns }) {
  const values = [];
  const placeholders = rows.map((row) => {
    const rowPlaceholders = columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${rowPlaceholders.join(', ')})`;
  });
  const assignments = updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(', ');
  await pool.query(
    `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')})
     values ${placeholders.join(', ')}
     on conflict (${conflictTarget.split(',').map((value) => quoteIdent(value.trim())).join(', ')})
     do update set ${assignments}`,
    values,
  );
}

function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}
