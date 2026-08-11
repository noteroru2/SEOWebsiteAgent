import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSite,
  enqueueJob,
  claimNextJob,
  markJobSucceeded,
  markJobFailed,
  recoverStaleJobs,
  requestJobCancellation,
  touchJobHeartbeat,
} from '@seo-agent/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://seo_agent:local_only_change_me@127.0.0.1:55432/seo_agent';
const suite = describe;
suite('database, migrations, and queue', () => {
  const database = createDatabase(url);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
  });
  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE system_events,ai_usage,approvals,opportunities,seo_issues,crawl_pages,crawl_runs,job_events,jobs,site_repositories,sites CASCADE',
    );
  });
  afterAll(async () => database.pool.end());

  it('migration creates the required tables', async () => {
    const result = await database.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const names = result.rows.map((r) => r.table_name);
    for (const name of [
      'sites',
      'site_repositories',
      'jobs',
      'job_events',
      'crawl_runs',
      'crawl_pages',
      'seo_issues',
      'opportunities',
      'approvals',
      'ai_usage',
      'system_events',
    ])
      expect(names).toContain(name);
  });
  it('creates a validated site', async () => {
    const site = await createSite({ name: 'Demo Site', url: 'https://example.com' }, database.db);
    expect(site.id).toBeTruthy();
  });
  it('enqueues and claims SYSTEM_TEST', async () => {
    const job = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    expect(job.status).toBe('QUEUED');
    const claimed = await claimNextJob('test-worker', database.pool);
    expect(claimed?.status).toBe('RUNNING');
    expect(claimed?.attempt_count).toBe(1);
  });
  it('marks a running job successful', async () => {
    const job = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    await claimNextJob('test-worker', database.pool);
    const done = await markJobSucceeded(job.id, { ok: true }, database.pool);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.finished_at).toBeTruthy();
  });
  it('marks failures with safe structured fields', async () => {
    const job = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    await claimNextJob('test-worker', database.pool);
    const done = await markJobFailed(job.id, 'TEST_FAILURE', 'Safe summary', database.pool);
    expect(done.failure_code).toBe('TEST_FAILURE');
    expect(done.failure_summary).toBe('Safe summary');
  });
  it('allows only one heavy running job', async () => {
    await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    const [first, second] = await Promise.all([
      claimNextJob('one', database.pool),
      claimNextJob('two', database.pool),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
  it('recovers stale RUNNING work without resetting attempts', async () => {
    const job = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    await claimNextJob('lost-worker', database.pool);
    await database.pool.query("UPDATE jobs SET heartbeat_at=now()-interval '1 hour' WHERE id=$1", [
      job.id,
    ]);
    const recovered = await recoverStaleJobs(15, database.db);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe('QUEUED');
    expect(recovered[0]!.attemptCount).toBe(1);
  });
  it('supports queued cancellation and heartbeat updates', async () => {
    const cancelled = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    expect((await requestJobCancellation(cancelled.id, database.db))?.status).toBe('CANCELLED');
    const running = await enqueueJob({ type: 'SYSTEM_TEST' }, database.db);
    await claimNextJob('heartbeat-worker', database.pool);
    await touchJobHeartbeat(running.id, database.db);
    const result = await database.pool.query('SELECT heartbeat_at FROM jobs WHERE id=$1', [
      running.id,
    ]);
    expect(result.rows[0].heartbeat_at).toBeTruthy();
  });
});
