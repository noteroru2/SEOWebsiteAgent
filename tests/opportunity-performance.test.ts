import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, createSite, enqueueJob } from '@seo-agent/database';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

describe('opportunity engine pilot-scale synthetic pipeline', () => {
  const database = createDatabase(requireTestDatabaseUrl());
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  afterAll(async () => database.pool.end());

  it('processes 1,500 crawl pages, 10,000 queries, and 50,000 query-page rows boundedly', async () => {
    await resetTestDatabase(database.pool);
    const sizeBefore = Number(
      (await database.pool.query(`SELECT pg_database_size(current_database()) size`)).rows[0].size,
    );
    const site = await createSite(
      { name: 'Synthetic Opportunity Scale', url: 'https://scale.example.com/' },
      database.db,
    );
    const crawl = await database.pool.query(
      `INSERT INTO crawl_runs(site_id,status,started_at,finished_at,pages_crawled,pages_indexable)
       VALUES($1,'SUCCEEDED',now(),now(),1500,1500) RETURNING id`,
      [site.id],
    );
    const connection = await database.pool.query(
      `INSERT INTO gsc_connections(site_id,encrypted_refresh_token,encrypted_access_token,scope,status)
       VALUES($1,'fixture','fixture','https://www.googleapis.com/auth/webmasters.readonly','CONNECTED') RETURNING id`,
      [site.id],
    );
    const property = await database.pool.query(
      `INSERT INTO gsc_properties(connection_id,property_uri,property_type,permission_level)
       VALUES($1,'sc-domain:scale.example.com','DOMAIN','siteOwner') RETURNING id`,
      [connection.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO site_gsc_properties(site_id,property_id,connection_id) VALUES($1,$2,$3)`,
      [site.id, property.rows[0].id, connection.rows[0].id],
    );
    const sync = await database.pool.query(
      `INSERT INTO gsc_sync_runs(site_id,property_id,mode,start_date,end_date,status,finished_at)
       VALUES($1,$2,'INCREMENTAL','2026-07-12','2026-08-08','SUCCEEDED',now()) RETURNING id`,
      [site.id, property.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_sync_summaries(site_id,property_id,last_sync_run_id,last_finalized_date,latest_status)
       VALUES($1,$2,$3,'2026-08-08','SUCCEEDED')`,
      [site.id, property.rows[0].id, sync.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO crawl_pages(crawl_run_id,url,final_url,status_code,indexable,in_sitemap)
       SELECT $1,'https://scale.example.com/page-'||n,'https://scale.example.com/page-'||n,200,true,true
       FROM generate_series(1,1500) n`,
      [crawl.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_page_metrics(site_id,property_id,metric_date,page,clicks,impressions,ctr,position)
       SELECT $1,$2,'2026-08-08','https://scale.example.com/page-'||n,10,200,0.05,8
       FROM generate_series(1,1500) n`,
      [site.id, property.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_page_crawl_mappings(site_id,property_id,gsc_page,crawl_run_id,crawl_page_id,reason)
       SELECT $1,$2,cp.url,$3,cp.id,'EXACT_URL' FROM crawl_pages cp WHERE cp.crawl_run_id=$3`,
      [site.id, property.rows[0].id, crawl.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_metrics(site_id,property_id,metric_date,query,clicks,impressions,ctr,position)
       SELECT $1,$2,'2026-08-08','query-'||n,5+(n%4),100+(n%100),
        (5+(n%4))::float8/(100+(n%100)),4+(n%12)
       FROM generate_series(1,10000) n`,
      [site.id, property.rows[0].id],
    );
    await database.pool.query(
      `INSERT INTO gsc_query_page_metrics(site_id,property_id,metric_date,query,page,clicks,impressions,ctr,position)
       SELECT $1,$2,'2026-08-08','query-'||q,
        'https://scale.example.com/page-'||(((q*5+p)%1500)+1),
        CASE p WHEN 1 THEN 3 WHEN 2 THEN 2 ELSE 0 END,
        CASE p WHEN 1 THEN 50 WHEN 2 THEN 30 ELSE 5 END,
        CASE p WHEN 1 THEN 0.06 WHEN 2 THEN 0.0666666667 ELSE 0 END,
        4+(q%12)+p::float8/10
       FROM generate_series(1,10000) q CROSS JOIN generate_series(1,5) p`,
      [site.id, property.rows[0].id],
    );
    // One-shot fixture inserts bypass the normal chunked-ingestion/autovacuum cadence.
    await database.pool.query(
      'ANALYZE gsc_query_metrics,gsc_page_metrics,gsc_query_page_metrics,gsc_page_crawl_mappings,crawl_pages,seo_issues',
    );
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const job = await enqueueJob({ type: 'GENERATE_OPPORTUNITIES', siteId: site.id }, database.db);
    const outcome = await executeOne(
      'synthetic-opportunity-worker',
      database.pool,
      new ResourceGuard(
        {},
        {
          collect: async () => ({
            freeMemoryMb: 2000,
            freeDiskMb: 10000,
            loadPerCpu: 0,
            platform: 'linux',
          }),
        },
      ),
    );
    const durationMs = Math.round(performance.now() - started);
    const rssAfter = process.memoryUsage().rss;
    const cpu = process.cpuUsage(cpuBefore);
    const sizeAfter = Number(
      (await database.pool.query(`SELECT pg_database_size(current_database()) size`)).rows[0].size,
    );
    const persisted = await database.pool.query(`SELECT result FROM jobs WHERE id=$1`, [job.id]);
    const result = persisted.rows[0].result;
    console.log(
      'OPPORTUNITY_SYNTHETIC_PERF',
      JSON.stringify({
        crawlPages: 1500,
        queryRows: 10000,
        queryPageRows: 50000,
        durationMs,
        rssBeforeMiB: Math.round(rssBefore / 104857.6) / 10,
        rssAfterMiB: Math.round(rssAfter / 104857.6) / 10,
        rssGrowthMiB: Math.round((rssAfter - rssBefore) / 104857.6) / 10,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        candidates: result?.candidatesGenerated,
        suppressed: result?.opportunitiesSuppressed,
        final: result?.final,
        dbGrowthBytes: sizeAfter - sizeBefore,
      }),
    );
    expect(outcome.state).toBe('SUCCEEDED');
    expect(result.candidatesGenerated).toBeGreaterThan(10000);
    expect(result.opportunitiesSuppressed).toBeGreaterThan(0);
    expect(result.final).toBeLessThanOrEqual(30);
  }, 60_000);
});
