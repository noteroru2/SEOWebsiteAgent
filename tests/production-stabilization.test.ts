import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  createDatabase,
  createSite,
  enqueueDueOpportunityWatches,
  ownerDashboardOverview,
  productionHealthSnapshot,
} from '@seo-agent/database';
import { validOwnerBasicAuthorization } from '../apps/web/lib/owner-auth';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const database = createDatabase(requireTestDatabaseUrl());

describe('production stabilization', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => resetTestDatabase(database.pool));
  afterAll(async () => database.pool.end());

  it('requires valid owner credentials when authentication is enabled', () => {
    const config = { required: true, username: 'owner', password: 'unique-password' };
    expect(validOwnerBasicAuthorization(null, config)).toBe(false);
    expect(
      validOwnerBasicAuthorization(
        `Basic ${Buffer.from('owner:wrong').toString('base64')}`,
        config,
      ),
    ).toBe(false);
    expect(
      validOwnerBasicAuthorization(
        `Basic ${Buffer.from('owner:unique-password').toString('base64')}`,
        config,
      ),
    ).toBe(true);
    expect(validOwnerBasicAuthorization(null, { required: false })).toBe(true);
  });

  it('derives owner-input counts from open owner evidence requests', async () => {
    const site = await createSite(
      { name: 'Owner Dashboard Fixture', url: 'https://owner-dashboard.example/' },
      database.db,
    );
    const opportunity = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,title,summary,fingerprint,status)
         VALUES($1,'LOW_CTR_QUERY','Owner input','Owner input','owner-dashboard','OPEN')
         RETURNING id`,
        [site.id],
      )
    ).rows[0];
    await database.pool.query(
      `INSERT INTO evidence_requests(opportunity_id,type,requirement,reason,source,required,status)
       VALUES($1,'OWNER_BUSINESS_FACT','Confirm business fact','Required','OWNER',true,'OPEN'),
             ($1,'GSC_PREVIOUS_PERIOD','Fetch GSC window','Required','GSC',true,'OPEN')`,
      [opportunity.id],
    );

    const overview = await ownerDashboardOverview(database.pool);
    expect(overview.errors).toEqual([]);
    expect(overview.activeOpportunitiesCount).toBe(1);
    expect(overview.ownerInputRequiredCount).toBe(1);
    expect(overview.sitesPortfolio).toHaveLength(1);
    expect(overview.sitesPortfolio[0].owner_input_count).toBe(1);
  });

  it('enqueues each due site at most once per Bangkok calendar day', async () => {
    const site = await createSite(
      { name: 'Scheduled Fixture', url: 'https://scheduled.example/' },
      database.db,
    );

    const beforeSchedule = await enqueueDueOpportunityWatches(
      new Date('2026-08-29T02:14:59.000Z'),
      database.pool,
    );
    expect(beforeSchedule.enqueued).toBe(0);

    const first = await enqueueDueOpportunityWatches(
      new Date('2026-08-29T02:15:00.000Z'),
      database.pool,
    );
    const second = await enqueueDueOpportunityWatches(
      new Date('2026-08-29T02:16:00.000Z'),
      database.pool,
    );
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);

    const jobs = await database.pool.query(
      `SELECT payload, max_attempts FROM jobs
       WHERE site_id=$1 AND type='PRODUCTION_OPPORTUNITY_WATCH'`,
      [site.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].payload).toMatchObject({
      scheduleDate: '2026-08-29',
      scheduleSource: 'DAILY_SCHEDULER',
      timezone: 'Asia/Bangkok',
    });
    expect(jobs.rows[0].max_attempts).toBe(1);
  });

  it('reports worker, scheduler, migration and runtime identity health truthfully', async () => {
    const now = new Date('2026-08-29T03:00:00.000Z');
    await database.pool.query(
      `INSERT INTO system_events(source,level,event,detail,created_at)
       VALUES('worker','INFO','HEARTBEAT','{}',$1),
             ('scheduler','INFO','SCHEDULER_TICK','{}',$1)`,
      [now],
    );
    const previousSha = process.env.APP_GIT_SHA;
    process.env.APP_GIT_SHA = 'a'.repeat(40);
    try {
      const health = await productionHealthSnapshot(
        { schedulerEnabled: true, expectedMigrationCount: 24, now },
        database.pool,
      );
      expect(health.status).toBe('HEALTHY');
      expect(health.versionConfigured).toBe(true);
      expect(health.worker.healthy).toBe(true);
      expect(health.scheduler.healthy).toBe(true);
      expect(health.migrations).toEqual({ healthy: true, applied: 24, expected: 24 });
    } finally {
      if (previousSha === undefined) delete process.env.APP_GIT_SHA;
      else process.env.APP_GIT_SHA = previousSha;
    }
  });
});
