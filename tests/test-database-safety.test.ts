import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertTestDatabaseConnection,
  requireTestDatabaseUrl,
  resetTestDatabase,
  validateTestDatabaseUrl,
  assertFixtureSafeDatabase,
} from '../packages/database/src/test-safety';

describe('test database fail-closed safety', () => {
  it('rejects a missing TEST_DATABASE_URL', () => {
    expect(() => validateTestDatabaseUrl(undefined, { nodeEnv: 'test' })).toThrow(
      'TEST_DATABASE_URL is required',
    );
  });

  it('rejects a non-test database name', () => {
    expect(() =>
      validateTestDatabaseUrl('postgresql://local@127.0.0.1:55432/seo_agent', {
        nodeEnv: 'test',
      }),
    ).toThrow('must target a database whose name ends in _test');
  });

  it('refuses destructive cleanup when the live connection is the development database', async () => {
    const pool = {
      query: async () => ({ rows: [{ database_name: 'seo_agent', marker: null }] }),
    } as unknown as Pool;
    await expect(assertTestDatabaseConnection(pool)).rejects.toThrow(
      'Connected database does not match TEST_DATABASE_URL',
    );
  });

  it('resets only the independently marked test database', async () => {
    const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    try {
      await assertTestDatabaseConnection(pool);
      await pool.query(
        `INSERT INTO system_events(source,level,event,detail)
         VALUES('test-safety','INFO','RESET_PROBE','{}')`,
      );
      await resetTestDatabase(pool);
      const result = await pool.query(
        `SELECT count(*)::int count FROM system_events WHERE event='RESET_PROBE'`,
      );
      expect(result.rows[0].count).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('refuses fixture execution when NODE_ENV=production', () => {
    const origEnv = process.env.NODE_ENV;
    const origAllow = process.env.ALLOW_FIXTURE_DATA;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      process.env.ALLOW_FIXTURE_DATA = 'true';
      expect(() => assertFixtureSafeDatabase({ context: 'test' })).toThrow('FIXTURE_GUARD_BLOCKED');
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
      process.env.ALLOW_FIXTURE_DATA = origAllow;
    }
  });

  it('refuses fixture execution when target is production database seo_agent', () => {
    const origUrl = process.env.DATABASE_URL;
    const origAllow = process.env.ALLOW_FIXTURE_DATA;
    try {
      process.env.DATABASE_URL = 'postgresql://seo_agent:secret@127.0.0.1:55432/seo_agent';
      process.env.ALLOW_FIXTURE_DATA = 'true';
      expect(() => assertFixtureSafeDatabase({ context: 'prod_db_test' })).toThrow(
        'FIXTURE_GUARD_BLOCKED',
      );
    } finally {
      process.env.DATABASE_URL = origUrl;
      process.env.ALLOW_FIXTURE_DATA = origAllow;
    }
  });

  it('refuses fixture execution when ALLOW_FIXTURE_DATA is not true', () => {
    const origAllow = process.env.ALLOW_FIXTURE_DATA;
    const origEnv = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    try {
      delete process.env.ALLOW_FIXTURE_DATA;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgresql://dev_user:pass@127.0.0.1:55432/seo_agent_dev';
      expect(() => assertFixtureSafeDatabase({ context: 'missing_allow' })).toThrow(
        'ALLOW_FIXTURE_DATA=true',
      );
    } finally {
      process.env.ALLOW_FIXTURE_DATA = origAllow;
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
      process.env.DATABASE_URL = origUrl;
    }
  });

  it('allows fixture execution in test environment when explicitly enabled', () => {
    const origAllow = process.env.ALLOW_FIXTURE_DATA;
    const origEnv = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    try {
      process.env.ALLOW_FIXTURE_DATA = 'true';
      (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
      process.env.DATABASE_URL = 'postgresql://test_user:pass@127.0.0.1:55432/seo_agent_test';
      expect(() => assertFixtureSafeDatabase({ context: 'valid_test' })).not.toThrow();
    } finally {
      process.env.ALLOW_FIXTURE_DATA = origAllow;
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
      process.env.DATABASE_URL = origUrl;
    }
  });
});
