import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  createDatabase,
  createSite,
  dismissOpportunity,
  enqueueJob,
  opportunityDetail,
} from '@seo-agent/database';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const database = createDatabase(requireTestDatabaseUrl());
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
let siteId = '';

async function seedFixture() {
  const site = await createSite(
    { name: 'Opportunity Fixture', url: 'https://opportunity.example.com/' },
    database.db,
  );
  siteId = site.id;
  const crawl = await database.pool.query(
    `INSERT INTO crawl_runs(site_id,status,started_at,finished_at,pages_crawled,pages_indexable)
     VALUES($1,'SUCCEEDED',now(),now(),7,7) RETURNING id`,
    [siteId],
  );
  const connection = await database.pool.query(
    `INSERT INTO gsc_connections(site_id,encrypted_refresh_token,encrypted_access_token,scope,status)
     VALUES($1,'fixture','fixture','https://www.googleapis.com/auth/webmasters.readonly','CONNECTED') RETURNING id`,
    [siteId],
  );
  const property = await database.pool.query(
    `INSERT INTO gsc_properties(connection_id,property_uri,property_type,permission_level)
     VALUES($1,'sc-domain:opportunity.example.com','DOMAIN','siteOwner') RETURNING id`,
    [connection.rows[0].id],
  );
  await database.pool.query(
    `INSERT INTO site_gsc_properties(site_id,property_id,connection_id) VALUES($1,$2,$3)`,
    [siteId, property.rows[0].id, connection.rows[0].id],
  );
  const sync = await database.pool.query(
    `INSERT INTO gsc_sync_runs(site_id,property_id,mode,start_date,end_date,status,finished_at)
     VALUES($1,$2,'INCREMENTAL','2026-07-12','2026-08-08','SUCCEEDED',now()) RETURNING id`,
    [siteId, property.rows[0].id],
  );
  await database.pool.query(
    `INSERT INTO gsc_sync_summaries(site_id,property_id,last_sync_run_id,last_finalized_date,latest_status)
     VALUES($1,$2,$3,'2026-08-08','SUCCEEDED')`,
    [siteId, property.rows[0].id, sync.rows[0].id],
  );
  const signals = [
    ...Array.from({ length: 5 }, (_, index) => ({
      query: `baseline-${index}`,
      impressions: 50,
      clicks: 5,
      position: 5,
    })),
    { query: 'striking target', impressions: 120, clicks: 12, position: 8 },
    { query: 'low ctr target', impressions: 100, clicks: 1, position: 5 },
  ];
  for (const [index, signal] of signals.entries()) {
    const page = `https://opportunity.example.com/page-${index}`;
    const crawlPage = await database.pool.query(
      `INSERT INTO crawl_pages(crawl_run_id,url,final_url,status_code,indexable,in_sitemap)
       VALUES($1,$2,$2,200,true,true) RETURNING id`,
      [crawl.rows[0].id, page],
    );
    await database.pool.query(
      `INSERT INTO gsc_page_crawl_mappings(site_id,property_id,gsc_page,crawl_run_id,crawl_page_id,reason)
       VALUES($1,$2,$3,$4,$5,'EXACT_URL')`,
      [siteId, property.rows[0].id, page, crawl.rows[0].id, crawlPage.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_metrics(site_id,property_id,metric_date,query,clicks,impressions,ctr,position)
       VALUES($1,$2,'2026-08-08',$3,$4,$5,$6,$7)`,
      [
        siteId,
        property.rows[0].id,
        signal.query,
        signal.clicks,
        signal.impressions,
        signal.clicks / signal.impressions,
        signal.position,
      ],
    );
    await database.pool.query(
      `INSERT INTO gsc_page_metrics(site_id,property_id,metric_date,page,clicks,impressions,ctr,position)
       VALUES($1,$2,'2026-08-08',$3,$4,$5,$6,$7)`,
      [
        siteId,
        property.rows[0].id,
        page,
        signal.clicks,
        signal.impressions,
        signal.clicks / signal.impressions,
        signal.position,
      ],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_page_metrics(site_id,property_id,metric_date,query,page,clicks,impressions,ctr,position)
       VALUES($1,$2,'2026-08-08',$3,$4,$5,$6,$7,$8)`,
      [
        siteId,
        property.rows[0].id,
        signal.query,
        page,
        signal.clicks,
        signal.impressions,
        signal.clicks / signal.impressions,
        signal.position,
      ],
    );
  }
}

async function generate() {
  const job = await enqueueJob({ type: 'GENERATE_OPPORTUNITIES', siteId }, database.db);
  const outcome = await executeOne('opportunity-test-worker', database.pool, guard);
  expect(outcome.state).toBe('SUCCEEDED');
  return job;
}

describe('opportunity persistence and worker pipeline', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    await seedFixture();
  });
  afterAll(async () => database.pool.end());

  it('coalesces duplicate active generation jobs and completes with lifecycle events', async () => {
    const first = await enqueueJob({ type: 'GENERATE_OPPORTUNITIES', siteId }, database.db);
    const duplicate = await enqueueJob({ type: 'GENERATE_OPPORTUNITIES', siteId }, database.db);
    expect(duplicate.id).toBe(first.id);
    expect((await executeOne('opportunity-test-worker', database.pool, guard)).state).toBe(
      'SUCCEEDED',
    );
    const jobs = await database.pool.query(
      `SELECT count(*)::int count FROM jobs WHERE site_id=$1 AND type='GENERATE_OPPORTUNITIES'`,
      [siteId],
    );
    expect(jobs.rows[0].count).toBe(1);
    const events = await database.pool.query(
      `SELECT event FROM job_events WHERE job_id=$1 ORDER BY created_at`,
      [first.id],
    );
    expect(events.rows.map((row) => row.event)).toContain('OPPORTUNITY_RUN_STARTED');
    expect(events.rows.map((row) => row.event)).toContain('OPPORTUNITY_RUN_COMPLETED');
    const card = await database.pool.query(
      `SELECT id FROM opportunities WHERE site_id=$1 AND kind='STRIKING_DISTANCE_QUERY'
       AND query='striking target'`,
      [siteId],
    );
    const detail = await opportunityDetail(card.rows[0].id, database.pool);
    expect(detail?.relatedGsc).toMatchObject({ clicks: 12, impressions: 120, position: 8 });
  });

  it('is idempotent and keeps dismissal persistent', async () => {
    await generate();
    const before = await database.pool.query(
      `SELECT id,fingerprint FROM opportunities WHERE site_id=$1 ORDER BY fingerprint`,
      [siteId],
    );
    const dismissed = before.rows[0];
    await dismissOpportunity(dismissed.id, database.pool);
    await generate();
    const after = await database.pool.query(
      `SELECT id,fingerprint,status FROM opportunities WHERE site_id=$1 ORDER BY fingerprint`,
      [siteId],
    );
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.find((row) => row.fingerprint === dismissed.fingerprint)?.status).toBe(
      'DISMISSED',
    );
  });

  it('requires two missing runs to resolve and reopens a reappearing fingerprint', async () => {
    await generate();
    const target = await database.pool.query(
      `SELECT id,fingerprint FROM opportunities WHERE site_id=$1 AND kind='STRIKING_DISTANCE_QUERY' AND query='striking target'`,
      [siteId],
    );
    expect(target.rowCount).toBe(1);
    await database.pool.query(
      `DELETE FROM gsc_query_page_metrics WHERE site_id=$1 AND query='striking target'`,
      [siteId],
    );
    await database.pool.query(
      `DELETE FROM gsc_query_metrics WHERE site_id=$1 AND query='striking target'`,
      [siteId],
    );
    await generate();
    let state = await database.pool.query(
      `SELECT status,missing_run_count FROM opportunities WHERE id=$1`,
      [target.rows[0].id],
    );
    expect(state.rows[0]).toMatchObject({ status: 'OPEN', missing_run_count: 1 });
    await generate();
    state = await database.pool.query(
      `SELECT status,missing_run_count FROM opportunities WHERE id=$1`,
      [target.rows[0].id],
    );
    expect(state.rows[0]).toMatchObject({ status: 'RESOLVED', missing_run_count: 2 });
    const property = await database.pool.query(
      `SELECT property_id FROM site_gsc_properties WHERE site_id=$1`,
      [siteId],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_metrics(site_id,property_id,metric_date,query,clicks,impressions,ctr,position)
       VALUES($1,$2,'2026-08-08','striking target',12,120,0.1,8)`,
      [siteId, property.rows[0].property_id],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_page_metrics(site_id,property_id,metric_date,query,page,clicks,impressions,ctr,position)
       VALUES($1,$2,'2026-08-08','striking target','https://opportunity.example.com/page-5',12,120,0.1,8)`,
      [siteId, property.rows[0].property_id],
    );
    await generate();
    state = await database.pool.query(
      `SELECT status,missing_run_count FROM opportunities WHERE id=$1`,
      [target.rows[0].id],
    );
    expect(state.rows[0]).toMatchObject({ status: 'OPEN', missing_run_count: 0 });
  });
});
