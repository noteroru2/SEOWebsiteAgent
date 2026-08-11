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
import { sql } from 'drizzle-orm';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const url = requireTestDatabaseUrl();
const suite = describe;
suite('database, migrations, and queue', () => {
  const database = createDatabase(url);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
  });
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
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
      'opportunity_runs',
      'approvals',
      'ai_usage',
      'ai_analysis_runs',
      'ai_recommendations',
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
  it('allows only one AI analysis to run across concurrent workers', async () => {
    const site = await createSite(
      { name: 'AI Queue', url: 'https://ai-queue.example.com' },
      database.db,
    );
    const opportunities = await database.pool.query(
      `INSERT INTO opportunities(site_id,kind,title,summary,fingerprint,engine_version)
       VALUES($1,'LOW_CTR_QUERY','One','One','ai-one','opportunity-engine-v1'),
             ($1,'LOW_CTR_QUERY','Two','Two','ai-two','opportunity-engine-v1') RETURNING id`,
      [site.id],
    );
    for (const opportunity of opportunities.rows)
      await enqueueJob(
        { type: 'ANALYZE_OPPORTUNITY', siteId: site.id, opportunityId: opportunity.id },
        database.db,
      );
    const [first, second] = await Promise.all([
      claimNextJob('ai-worker-one', database.pool),
      claimNextJob('ai-worker-two', database.pool),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.type).toBe('ANALYZE_OPPORTUNITY');
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
  it('coalesces a duplicate GSC bootstrap while a fresh-site sync is queued', async () => {
    await database.db.transaction(async (tx) => {
      const txDatabase = tx as unknown as typeof database.db;
      const site = await createSite(
        { name: 'Fresh GSC Site', url: 'https://example.com' },
        txDatabase,
      );
      const queued = await enqueueJob(
        { type: 'GSC_SYNC', siteId: site.id, mode: 'INCREMENTAL' },
        txDatabase,
      );
      const duplicate = await enqueueJob(
        { type: 'GSC_SYNC', siteId: site.id, mode: 'BOOTSTRAP_28D' },
        txDatabase,
      );

      expect(duplicate.id).toBe(queued.id);
      const jobs = (await tx.execute(
        sql`SELECT payload FROM jobs WHERE site_id=${site.id} AND type='GSC_SYNC'`,
      )) as unknown as { rows: Array<{ payload: { mode: string } }> };
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]!.payload.mode).toBe('INCREMENTAL');
      const events = (await tx.execute(
        sql`SELECT event FROM job_events WHERE job_id=${queued.id} ORDER BY created_at`,
      )) as unknown as { rows: Array<{ event: string }> };
      expect(events.rows.map((row) => row.event)).toEqual(['ENQUEUED']);

      await tx.execute(sql`DELETE FROM jobs WHERE id=${queued.id}`);
      await tx.execute(sql`DELETE FROM sites WHERE id=${site.id}`);
    });
  });
});
