import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  createDatabase,
  createSite,
  enqueueDueOpportunityWatches,
  ownerDashboardOverview,
  productionHealthSnapshot,
} from '@seo-agent/database';
import { validOwnerBasicAuthorization } from '../apps/web/lib/owner-auth';
import { GET as liveHealth } from '../apps/web/app/api/health/live/route';
import { config as proxyConfig } from '../apps/web/proxy';
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

  it('exposes only process liveness on the public health route', async () => {
    const response = liveHealth();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(proxyConfig.matcher[0]).toContain('api/health/live');
    expect(proxyConfig.matcher[0]).not.toContain('api/health|');
  });

  it('keeps container database credentials mandatory and host tooling separate', async () => {
    const compose = await readFile('docker-compose.yml', 'utf8');
    expect(compose).toContain(
      'DATABASE_URL: ${CONTAINER_DATABASE_URL:?CONTAINER_DATABASE_URL is required}',
    );
    expect(compose).toContain(
      'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}',
    );
    expect(compose).not.toContain(
      'DATABASE_URL: postgresql://seo_agent:local_only_change_me@postgres:5432/seo_agent',
    );
    expect(compose.match(/restart: unless-stopped/g)).toHaveLength(3);
    expect(compose).toMatch(/migrate:[\s\S]*restart: 'no'/);
  });

  it('checks pg_dump before publishing an atomic compressed backup', async () => {
    const script = await readFile('scripts/backup-postgres.sh', 'utf8');
    expect(script).not.toMatch(/pg_dump[^\n]*\|[^\n]*gzip/);
    expect(script).toContain('pg_dump -U "$user" "$database" > "$temporary_dump"');
    expect(script).toContain('gzip -t "$temporary_archive"');
    expect(script).toContain('mv "$temporary_archive" "$archive"');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
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
      expect(health.queue).toEqual({ healthy: true, queued: 0, running: 0, staleRunning: 0 });
      expect(health.migrations).toEqual({ healthy: true, applied: 24, expected: 24 });

      await database.pool.query(
        `DELETE FROM system_events WHERE source='scheduler' AND event='SCHEDULER_TICK'`,
      );
      const disabledScheduler = await productionHealthSnapshot(
        { schedulerEnabled: false, expectedMigrationCount: 24, now },
        database.pool,
      );
      expect(disabledScheduler.status).toBe('HEALTHY');
      expect(disabledScheduler.scheduler).toMatchObject({
        enabled: false,
        required: false,
        healthy: true,
        heartbeat: null,
      });

      process.env.APP_GIT_SHA = 'development';
      const invalidVersion = await productionHealthSnapshot(
        { schedulerEnabled: true, expectedMigrationCount: 24, now },
        database.pool,
      );
      expect(invalidVersion.status).toBe('DEGRADED');
      expect(invalidVersion.versionConfigured).toBe(false);
    } finally {
      if (previousSha === undefined) delete process.env.APP_GIT_SHA;
      else process.env.APP_GIT_SHA = previousSha;
    }
  });
});
