import test from 'node:test';
import assert from 'node:assert/strict';

import { createMissionControlDb } from '../mission-control-db.mjs';

function withoutProcessDatabaseUrl(run) {
  const original = process.env.MISSION_CONTROL_DATABASE_URL;
  delete process.env.MISSION_CONTROL_DATABASE_URL;

  try {
    return run();
  } finally {
    if (original === undefined) {
      delete process.env.MISSION_CONTROL_DATABASE_URL;
    } else {
      process.env.MISSION_CONTROL_DATABASE_URL = original;
    }
  }
}

test('createMissionControlDb requires MISSION_CONTROL_DATABASE_URL and never falls back to Supabase', () => {
  withoutProcessDatabaseUrl(() => {
    assert.throws(
      () => createMissionControlDb({
        env: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        },
        envPath: '.env.test',
      }),
      new Error('Missing MISSION_CONTROL_DATABASE_URL in .env.test'),
    );
  });
});

test('createMissionControlDb returns the Postgres backend when MISSION_CONTROL_DATABASE_URL is set', async () => {
  const db = withoutProcessDatabaseUrl(() => createMissionControlDb({
    env: {
      MISSION_CONTROL_DATABASE_URL: 'postgresql://mission-control:test@127.0.0.1:5432/mission_control_test',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    },
    envPath: '.env.test',
  }));

  assert.equal(db.kind, 'postgres');
  assert.equal(db.description, 'local Postgres via MISSION_CONTROL_DATABASE_URL');
  await db.close();
});
