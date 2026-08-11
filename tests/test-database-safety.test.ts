import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertTestDatabaseConnection,
  requireTestDatabaseUrl,
  resetTestDatabase,
  validateTestDatabaseUrl,
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
});
