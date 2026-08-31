import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { NextRequest } from 'next/server';
import {
  createDatabase,
  createSite,
  enqueueDueOpportunityWatches,
  enqueueManualOpportunityWatch,
  manualCommandSnapshot,
  manualRunStatus,
} from '@seo-agent/database';
import { GET, POST } from '../apps/web/app/api/jobs/run-now/route';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const database = createDatabase(requireTestDatabaseUrl());
const originalManualFlag = process.env.LOCAL_MANUAL_COMMANDS_ENABLED;

async function eligibleSite(name = 'Manual Site', active = true) {
  const site = await createSite(
    { name, url: `https://${name.toLowerCase().replaceAll(' ', '-')}.example/`, active },
    database.db,
  );
  await database.pool.query(
    `UPDATE sites SET source_status='CURRENT',watch_mode='ANALYSIS_ENABLED' WHERE id=$1`,
    [site.id],
  );
  await database.pool.query(
    `INSERT INTO site_repositories(site_id,local_path,enabled,head_sha,current_branch,worktree_clean)
     VALUES($1,$2,true,$3,'main',true)`,
    [site.id, `C:\\source\\${site.id}`, 'a'.repeat(40)],
  );
  return site;
}

async function workerHeartbeat(status = 'READY') {
  await database.pool.query(
    `INSERT INTO system_events(source,level,event,detail)
     VALUES('worker','INFO','HEARTBEAT',$1::jsonb)`,
    [
      JSON.stringify({
        gitSha: 'b'.repeat(40),
        schedulerEnabled: true,
        schedulerDailyAt: '10:00',
        schedulerTimezone: 'Asia/Bangkok',
        executor: { status, reasons: status === 'READY' ? [] : ['LOW_DISK'] },
      }),
    ],
  );
}

describe('local manual command center', () => {
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    process.env.LOCAL_MANUAL_COMMANDS_ENABLED = 'true';
  });
  beforeEach(async () => resetTestDatabase(database.pool));
  afterAll(async () => {
    if (originalManualFlag === undefined) delete process.env.LOCAL_MANUAL_COMMANDS_ENABLED;
    else process.env.LOCAL_MANUAL_COMMANDS_ENABLED = originalManualFlag;
    await database.pool.end();
  });

  it('enqueues one selected eligible site with manual identity and audit events', async () => {
    const site = await eligibleSite();
    const result = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id, requestedAt: new Date('2026-08-31T03:30:00Z') },
      database.pool,
    );
    expect(result).toMatchObject({ requested: 1, eligible: 1, enqueued: 1 });
    const job = (
      await database.pool.query(`SELECT payload,max_attempts FROM jobs WHERE id=$1`, [
        result.jobIds[0],
      ])
    ).rows[0];
    expect(job.payload).toMatchObject({
      commandRunId: result.runId,
      commandSource: 'MANUAL_OWNER',
      scheduleDate: '2026-08-31',
      timezone: 'Asia/Bangkok',
    });
    expect(job.max_attempts).toBe(1);
    const events = await database.pool.query(
      `SELECT event FROM system_events WHERE detail->>'commandRunId'=$1 ORDER BY created_at`,
      [result.runId],
    );
    expect(events.rows.map((row) => row.event)).toEqual([
      'MANUAL_RUN_REQUESTED',
      'MANUAL_RUN_ENQUEUED',
    ]);
  });

  it('enqueues all eligible sites and skips inactive or unsafe sites', async () => {
    await eligibleSite('Eligible One');
    await eligibleSite('Eligible Two');
    await eligibleSite('Inactive Site', false);
    await createSite({ name: 'No Source', url: 'https://no-source.example/' }, database.db);
    const result = await enqueueManualOpportunityWatch({ mode: 'ALL' }, database.pool);
    expect(result).toMatchObject({ requested: 4, eligible: 2, enqueued: 2 });
    expect(result.skipped.map((row) => row.reason).sort()).toEqual([
      'SITE_INACTIVE',
      'SOURCE_NOT_CURRENT',
    ]);
  });

  it('deduplicates queued and running jobs rather than relying on the UI', async () => {
    const site = await eligibleSite();
    const first = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    const queued = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    expect(queued).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
    await database.pool.query(`UPDATE jobs SET status='RUNNING' WHERE id=$1`, [first.jobIds[0]]);
    const running = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    expect(running).toMatchObject({ enqueued: 0, alreadyRunning: 1 });
    expect(
      Number(
        (await database.pool.query(`SELECT count(*) count FROM jobs WHERE site_id=$1`, [site.id]))
          .rows[0].count,
      ),
    ).toBe(1);
  });

  it('allows a manual command after an imported cancelled migration job', async () => {
    const site = await eligibleSite();
    await database.pool.query(
      `INSERT INTO jobs(site_id,type,status,heavy,payload,max_attempts,result)
       VALUES($1,'PRODUCTION_OPPORTUNITY_WATCH','CANCELLED',false,'{}',1,$2::jsonb)`,
      [site.id, JSON.stringify({ reason: 'LOCAL_MIGRATION_QUEUE_RETIRED' })],
    );
    const result = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    expect(result.enqueued).toBe(1);
  });

  it('counts a completed manual watch for same-day scheduler idempotency', async () => {
    const site = await eligibleSite();
    const now = new Date('2026-08-31T03:30:00Z');
    const manual = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id, requestedAt: now },
      database.pool,
    );
    await database.pool.query(`UPDATE jobs SET status='SUCCEEDED',finished_at=$2 WHERE id=$1`, [
      manual.jobIds[0],
      now,
    ]);
    const scheduled = await enqueueDueOpportunityWatches(now, database.pool, '10:00');
    expect(scheduled.enqueued).toBe(0);
  });

  it('does not enqueue a second manual watch after same-day success', async () => {
    const site = await eligibleSite();
    const now = new Date('2026-08-31T03:30:00Z');
    const first = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id, requestedAt: now },
      database.pool,
    );
    await database.pool.query(`UPDATE jobs SET status='SUCCEEDED',finished_at=$2 WHERE id=$1`, [
      first.jobIds[0],
      now,
    ]);
    const second = await enqueueManualOpportunityWatch(
      { mode: 'ALL', requestedAt: now },
      database.pool,
    );
    expect(second).toMatchObject({ enqueued: 0, alreadyCompletedToday: 1 });
    expect(second.skipped).toContainEqual(
      expect.objectContaining({ siteId: site.id, reason: 'ALREADY_COMPLETED_TODAY' }),
    );
  });

  it('serializes a scheduler/manual race and double-clicks to one active job', async () => {
    const site = await eligibleSite();
    const now = new Date('2026-08-31T03:30:00Z');
    await Promise.all([
      enqueueManualOpportunityWatch(
        { mode: 'SITE', siteId: site.id, requestedAt: now },
        database.pool,
      ),
      enqueueManualOpportunityWatch(
        { mode: 'SITE', siteId: site.id, requestedAt: now },
        database.pool,
      ),
      enqueueDueOpportunityWatches(now, database.pool, '10:00'),
    ]);
    const jobs = await database.pool.query(
      `SELECT status FROM jobs WHERE site_id=$1 AND type='PRODUCTION_OPPORTUNITY_WATCH'`,
      [site.id],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('reports worker/executor readiness, queue and runtime identity from DB heartbeats', async () => {
    await eligibleSite();
    await workerHeartbeat('BLOCKED_LOW_DISK');
    const snapshot = await manualCommandSnapshot(new Date(), database.pool);
    expect(snapshot.worker.healthy).toBe(true);
    expect(snapshot.executor).toMatchObject({ ready: false, status: 'BLOCKED_LOW_DISK' });
    expect(snapshot.scheduler).toMatchObject({ enabled: true, dailyAt: '10:00' });
    expect(snapshot.eligibleSites).toBe(1);
  });

  it('reports recent command progress from the actual jobs', async () => {
    const site = await eligibleSite();
    const result = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    let snapshot = await manualCommandSnapshot(new Date(), database.pool);
    expect(snapshot.recentCommands[0]).toMatchObject({
      commandRunId: result.runId,
      status: 'QUEUED',
      counts: { queued: 1, running: 0, completed: 0, failed: 0 },
    });
    await database.pool.query(`UPDATE jobs SET status='SUCCEEDED',finished_at=now() WHERE id=$1`, [
      result.jobIds[0],
    ]);
    snapshot = await manualCommandSnapshot(new Date(), database.pool);
    expect(snapshot.recentCommands[0]).toMatchObject({
      status: 'COMPLETED',
      counts: { queued: 0, completed: 1, failed: 0 },
    });
  });

  it('validates API input, unknown sites, worker availability and resource guard state', async () => {
    await eligibleSite();
    let response = await POST(
      new NextRequest('http://localhost/api/jobs/run-now', {
        method: 'POST',
        body: JSON.stringify({ mode: 'SITE', siteId: 'not-a-uuid' }),
      }),
    );
    expect(response.status).toBe(400);

    response = await POST(
      new NextRequest('http://localhost/api/jobs/run-now', {
        method: 'POST',
        body: JSON.stringify({ mode: 'ALL' }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('WORKER_UNAVAILABLE');

    await workerHeartbeat('BLOCKED_LOW_DISK');
    response = await POST(
      new NextRequest('http://localhost/api/jobs/run-now', {
        method: 'POST',
        body: JSON.stringify({ mode: 'ALL' }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('BLOCKED_LOW_DISK');

    await workerHeartbeat('READY');
    response = await POST(
      new NextRequest('http://localhost/api/jobs/run-now', {
        method: 'POST',
        body: JSON.stringify({ mode: 'SITE', siteId: '11111111-1111-4111-8111-111111111111' }),
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('SITE_NOT_FOUND');
  });

  it('returns structured command progress without any provider execution', async () => {
    const site = await eligibleSite();
    const result = await enqueueManualOpportunityWatch(
      { mode: 'SITE', siteId: site.id },
      database.pool,
    );
    const status = await manualRunStatus(result.runId, database.pool);
    expect(status.counts).toEqual({ queued: 1, running: 0, completed: 0, failed: 0, cancelled: 0 });
    const response = await GET(
      new NextRequest(`http://localhost/api/jobs/run-now?runId=${result.runId}`),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).runId).toBe(result.runId);
    expect(
      Number((await database.pool.query('SELECT count(*) count FROM ai_usage')).rows[0].count),
    ).toBe(0);
    expect(
      Number((await database.pool.query('SELECT count(*) count FROM serp_captures')).rows[0].count),
    ).toBe(0);
  });
});
