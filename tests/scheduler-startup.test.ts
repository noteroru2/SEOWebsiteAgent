import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  createDatabase,
  createProductionSchedulerRuntime,
  createSite,
  enqueueDueOpportunityWatches,
  pollProductionScheduler,
  productionHealthSnapshot,
  productionSchedulerEligibility,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const database = createDatabase(requireTestDatabaseUrl());

async function watchJobCount() {
  const result = await database.pool.query<{ count: number }>(
    `SELECT count(*)::int count FROM jobs WHERE type='PRODUCTION_OPPORTUNITY_WATCH'`,
  );
  return result.rows[0]?.count ?? 0;
}

async function schedulerTickCount() {
  const result = await database.pool.query<{ count: number }>(
    `SELECT count(*)::int count FROM system_events
     WHERE source='scheduler' AND event='SCHEDULER_TICK'`,
  );
  return result.rows[0]?.count ?? 0;
}

describe('scheduler startup eligibility', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => resetTestDatabase(database.pool));
  afterAll(async () => database.pool.end());

  it('A: starts before 09:15 and enqueues exactly once when the schedule is crossed', async () => {
    await createSite(
      { name: 'Before schedule', url: 'https://before-schedule.example/' },
      database.db,
    );
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T01:00:00.000Z'));

    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T01:00:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'WAITING_FOR_SCHEDULE', enqueued: 0 });
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T02:14:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'WAITING_FOR_SCHEDULE', enqueued: 0 });
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T02:15:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'ELIGIBLE', enqueued: 1 });
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T02:16:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'ELIGIBLE', enqueued: 0 });
    expect(await watchJobCount()).toBe(1);
  });

  it('B/H: skips every poll on a late-start date and resets at the next Bangkok boundary', async () => {
    await createSite({ name: 'Late start', url: 'https://late-start.example/' }, database.db);
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T04:00:00.000Z'));

    for (const timestamp of [
      '2026-08-29T04:00:00.000Z',
      '2026-08-29T04:05:00.000Z',
      '2026-08-29T11:00:00.000Z',
    ]) {
      expect(
        await pollProductionScheduler(
          runtime,
          { enabled: true, now: new Date(timestamp) },
          database.pool,
        ),
      ).toMatchObject({ eligibility: 'SKIPPED_LATE_START', enqueued: 0 });
    }
    expect(await watchJobCount()).toBe(0);
    expect(productionSchedulerEligibility(runtime, new Date('2026-08-30T02:14:00.000Z'))).toBe(
      'WAITING_FOR_SCHEDULE',
    );
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-30T02:14:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'WAITING_FOR_SCHEDULE', enqueued: 0 });
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-30T02:15:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'ELIGIBLE', enqueued: 1 });
    expect(await watchJobCount()).toBe(1);
  });

  it('C: creates no duplicate when a late-start date already has a scheduled job', async () => {
    await createSite({ name: 'Existing job', url: 'https://existing-job.example/' }, database.db);
    expect(
      await enqueueDueOpportunityWatches(new Date('2026-08-29T02:15:00.000Z'), database.pool),
    ).toMatchObject({ enqueued: 1 });
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T04:00:00.000Z'));
    expect(
      await pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T04:00:00.000Z') },
        database.pool,
      ),
    ).toMatchObject({ eligibility: 'SKIPPED_LATE_START', enqueued: 0 });
    expect(await watchJobCount()).toBe(1);
  });

  it('D: a continuously running pre-threshold worker schedules once per site/day', async () => {
    await createSite({ name: 'Continuous', url: 'https://continuous.example/' }, database.db);
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T00:30:00.000Z'));
    const polls = [];
    for (const timestamp of [
      '2026-08-29T02:14:00.000Z',
      '2026-08-29T02:15:00.000Z',
      '2026-08-29T02:16:00.000Z',
      '2026-08-29T10:00:00.000Z',
    ]) {
      polls.push(
        await pollProductionScheduler(
          runtime,
          { enabled: true, now: new Date(timestamp) },
          database.pool,
        ),
      );
    }
    expect(polls.map((poll) => poll.enqueued)).toEqual([0, 1, 0, 0]);
    expect(await watchJobCount()).toBe(1);
  });

  it('E: a 09:16 restart after a successful schedule creates no duplicate', async () => {
    await createSite({ name: 'Restarted', url: 'https://restarted.example/' }, database.db);
    await enqueueDueOpportunityWatches(new Date('2026-08-29T02:15:00.000Z'), database.pool);
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T02:16:00.000Z'));
    const result = await pollProductionScheduler(
      runtime,
      { enabled: true, now: new Date('2026-08-29T02:16:00.000Z') },
      database.pool,
    );
    expect(result).toMatchObject({ eligibility: 'SKIPPED_LATE_START', enqueued: 0 });
    expect(await watchJobCount()).toBe(1);
  });

  it('F: a disabled scheduler creates neither jobs nor scheduler heartbeats', async () => {
    await createSite({ name: 'Disabled', url: 'https://disabled.example/' }, database.db);
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T01:00:00.000Z'));
    const result = await pollProductionScheduler(
      runtime,
      { enabled: false, now: new Date('2026-08-29T02:15:00.000Z') },
      database.pool,
    );
    expect(result).toMatchObject({ eligibility: 'DISABLED', enqueued: 0 });
    expect(await watchJobCount()).toBe(0);
    expect(await schedulerTickCount()).toBe(0);
  });

  it('G: concurrent eligible polls retain lock/idempotency and create one job', async () => {
    await createSite({ name: 'Concurrent', url: 'https://concurrent.example/' }, database.db);
    const runtime = createProductionSchedulerRuntime(new Date('2026-08-29T01:00:00.000Z'));
    const results = await Promise.all([
      pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T02:15:00.000Z') },
        database.pool,
      ),
      pollProductionScheduler(
        runtime,
        { enabled: true, now: new Date('2026-08-29T02:15:00.000Z') },
        database.pool,
      ),
    ]);
    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);
    expect(await watchJobCount()).toBe(1);
  });

  it('keeps readiness healthy while a late-start date is intentionally skipped', async () => {
    await createSite({ name: 'Healthy skip', url: 'https://healthy-skip.example/' }, database.db);
    const now = new Date('2026-08-29T04:00:00.000Z');
    const runtime = createProductionSchedulerRuntime(now);
    const poll = await pollProductionScheduler(runtime, { enabled: true, now }, database.pool);
    expect(poll).toMatchObject({
      eligibility: 'SKIPPED_LATE_START',
      enqueued: 0,
      heartbeatRecorded: true,
    });
    await database.pool.query(
      `INSERT INTO system_events(source,level,event,detail,created_at)
       VALUES('worker','INFO','HEARTBEAT',$1::jsonb,$2)`,
      [JSON.stringify({ workerId: 'scheduler-startup-test' }), now],
    );

    const previousSha = process.env.APP_GIT_SHA;
    process.env.APP_GIT_SHA = 'a'.repeat(40);
    try {
      const health = await productionHealthSnapshot(
        { schedulerEnabled: true, expectedMigrationCount: 24, now },
        database.pool,
      );
      expect(health.status).toBe('HEALTHY');
      expect(health.scheduler).toMatchObject({ enabled: true, required: true, healthy: true });
      expect(health.queue).toMatchObject({ queued: 0, running: 0, staleRunning: 0 });
    } finally {
      if (previousSha === undefined) delete process.env.APP_GIT_SHA;
      else process.env.APP_GIT_SHA = previousSha;
    }
  });
});
