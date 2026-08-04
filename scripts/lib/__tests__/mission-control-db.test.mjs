import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

test('Supabase admin helper imports without credentials and creates clients lazily', async () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const moduleUrl = `${pathToFileURL(resolve('src/lib/supabase/admin.ts')).href}?lazy=${Date.now()}`;
    const admin = await import(moduleUrl);
    assert.ok(admin.supabaseAdmin);
    assert.equal(typeof admin.createServiceClient, 'function');
    assert.throws(() => admin.createServiceClient(), /NEXT_PUBLIC_SUPABASE_URL is required/);
  } finally {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
