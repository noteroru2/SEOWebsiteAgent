import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, enqueueJob, createSite, siteDetail } from '@seo-agent/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { startFixture } from './fixture-server';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const url = requireTestDatabaseUrl();
const suite = describe;
suite('SYSTEM_TEST end-to-end smoke', () => {
  const database = createDatabase(url);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    await resetTestDatabase(database.pool);
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

describe('SITE_CRAWL queue integration', () => {
  const database = createDatabase(url);
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => {
    process.env.SEO_AGENT_TEST_FIXTURE = '1';
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    await resetTestDatabase(database.pool);
    fixture = await startFixture();
  });
  afterAll(async () => {
    delete process.env.SEO_AGENT_TEST_FIXTURE;
    await fixture.close();
    await database.pool.end();
  });
  it('crawls, analyzes, persists a compact summary, and remains UI-readable', async () => {
    const site = await createSite(
      {
        name: 'Fixture Site',
        url: fixture.baseUrl,
        maxPages: 30,
        crawlDelayMs: 0,
        requestTimeoutMs: 1000,
      },
      database.db,
    );
    const queued = await enqueueJob({ type: 'SITE_CRAWL', siteId: site.id }, database.db);
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
    const result = await executeOne('crawl-e2e-worker', database.pool, guard);
    expect(result.state).toBe('SUCCEEDED');
    const persisted = await database.pool.query('SELECT status,result FROM jobs WHERE id=$1', [
      queued.id,
    ]);
    expect(persisted.rows[0].status).toBe('SUCCEEDED');
    const detail = await siteDetail(site.id, {}, database.db);
    expect(detail?.latest?.status).toBe('SUCCEEDED');
    expect(detail?.latest?.pagesCrawled).toBeGreaterThan(10);
    expect(detail?.latest?.issuesFound).toBeGreaterThan(5);
    expect(detail?.issues.some((issue) => issue.ruleCode === 'TITLE_MISSING')).toBe(true);
  });
});
