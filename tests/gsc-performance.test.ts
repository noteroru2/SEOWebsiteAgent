import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createSite, saveGscConnection, upsertGscRows } from '@seo-agent/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { encryptSecret, fetchDatasetPages } from '@seo-agent/gsc';
import { FakeSearchConsoleApi } from './fake-gsc-api';

const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://seo_agent:local_only_change_me@127.0.0.1:55432/seo_agent';
describe('GSC 50K bounded ingestion performance', () => {
  const database = createDatabase(url);
  let siteId = '';
  let propertyId = '';
  let propertyUri = '';
  const key = Buffer.alloc(32, 11).toString('base64');
  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = key;
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    const suffix = crypto.randomUUID();
    const site = await createSite(
      { name: '50K Fixture', url: `https://perf-${suffix}.example.com` },
      database.db,
    );
    siteId = site.id;
    propertyUri = `sc-domain:perf-${suffix}.example.com`;
    await saveGscConnection(
      {
        siteId,
        encryptedRefreshToken: encryptSecret('refresh'),
        encryptedAccessToken: encryptSecret('access'),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        properties: [{ propertyUri, permissionLevel: 'siteOwner' }],
      },
      database.pool,
    );
    propertyId = (
      await database.pool.query('SELECT id FROM gsc_properties WHERE property_uri=$1', [
        propertyUri,
      ])
    ).rows[0].id;
  });
  afterAll(async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    if (siteId) await database.pool.query('DELETE FROM sites WHERE id=$1', [siteId]);
    if (propertyUri)
      await database.pool.query(
        'DELETE FROM gsc_properties WHERE property_uri=$1 AND connection_id IS NULL',
        [propertyUri],
      );
    await database.pool.end();
  });
  it('streams and chunk-upserts 50,000 rows without retaining the dataset', async () => {
    const rowCount = Number(process.env.GSC_PERF_ROWS ?? 50_000);
    const api = new FakeSearchConsoleApi(rowCount);
    const beforeSize = Number(
      (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
    );
    const start = performance.now();
    let peak = process.memoryUsage().rss;
    const result = await fetchDatasetPages({
      api,
      propertyUri,
      date: api.populatedDate,
      dataset: 'QUERY_PAGE',
      maxPages: 4,
      onPage: async (rows) => {
        for (let offset = 0; offset < rows.length; offset += 500) {
          await upsertGscRows(
            'QUERY_PAGE',
            { siteId, propertyId, searchType: 'web' },
            rows.slice(offset, offset + 500),
            database.pool,
          );
          peak = Math.max(peak, process.memoryUsage().rss);
        }
      },
    });
    const durationMs = performance.now() - start;
    const afterSize = Number(
      (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
    );
    expect(result.rows).toBe(rowCount);
    expect(result.coverage).toBe(
      rowCount >= 50_000 ? 'POSSIBLY_TRUNCATED' : 'COMPLETE_AS_RETURNED',
    );
    expect(
      Number(
        (
          await database.pool.query(
            'SELECT count(*) count FROM gsc_query_page_metrics WHERE site_id=$1',
            [siteId],
          )
        ).rows[0].count,
      ),
    ).toBe(rowCount);
    console.log(
      `GSC_PERF_${rowCount}`,
      JSON.stringify({
        rows: rowCount,
        durationMs: Math.round(durationMs),
        peakRssBytes: peak,
        dbGrowthBytes: afterSize - beforeSize,
      }),
    );
  }, 60_000);
});
