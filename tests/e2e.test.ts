import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, enqueueJob } from '@seo-agent/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';

const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://seo_agent:local_only_change_me@127.0.0.1:55432/seo_agent';
const suite = describe;
suite('SYSTEM_TEST end-to-end smoke', () => {
  const database = createDatabase(url);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    await database.pool.query('TRUNCATE job_events,jobs CASCADE');
  });
  afterAll(async () => database.pool.end());
  it('flows from queue through worker to persisted success', async () => {
    const queued = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    const guard = new ResourceGuard(
      {},
      {
        collect: async () => ({
          freeMemoryMb: 2000,
          freeDiskMb: 10000,
          loadPerCpu: 0,
          platform: 'linux',
        }),
      },
    );
    const result = await executeOne('e2e-worker', database.pool, guard);
    expect(result.state).toBe('SUCCEEDED');
    const persisted = await database.pool.query('SELECT status,result FROM jobs WHERE id=$1', [
      queued.id,
    ]);
    expect(persisted.rows[0].status).toBe('SUCCEEDED');
    expect(persisted.rows[0].result.ok).toBe(true);
  });
});
