import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createGscOAuthState,
  consumeGscOAuthState,
  createSite,
  disconnectGsc,
  enqueueJob,
  gscSiteView,
  mapGscProperty,
  saveGscConnection,
} from '@seo-agent/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { encryptSecret } from '@seo-agent/gsc';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { FakeSearchConsoleApi } from './fake-gsc-api';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const url = requireTestDatabaseUrl();
const key = Buffer.alloc(32, 9).toString('base64');
describe('GSC fake full pipeline', () => {
  const database = createDatabase(url);
  let siteId = '';
  let propertyId = '';
  let propertyUri = '';
  const guard = new ResourceGuard(
    {},
    {
      collect: async () => ({
        freeMemoryMb: 2000,
        freeDiskMb: 20000,
        loadPerCpu: 0,
        platform: 'linux',
      }),
    },
  );
  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = key;
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    await resetTestDatabase(database.pool);
    const suffix = crypto.randomUUID();
    const site = await createSite(
      { name: 'GSC Fixture', url: `https://gsc-${suffix}.example.com` },
      database.db,
    );
    siteId = site.id;
    propertyUri = `sc-domain:gsc-${suffix}.example.com`;
    await saveGscConnection(
      {
        siteId,
        encryptedRefreshToken: encryptSecret('refresh'),
        encryptedAccessToken: encryptSecret('access'),
        accessTokenExpiresAt: new Date(Date.now() + 3600000),
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        properties: [
          { propertyUri, permissionLevel: 'siteOwner' },
          { propertyUri: `https://gsc-${suffix}.example.com/`, permissionLevel: 'siteFullUser' },
        ],
      },
      database.pool,
    );
    const view = await gscSiteView(siteId, {}, database.pool);
    console.log(
      'GSC_QUERY_PERF',
      JSON.stringify({ combinedBoundedViewMs: Math.round(view.timingMs * 100) / 100 }),
    );
    propertyId = view.properties[0].id;
    const mappedPropertyUri = view.properties[0].property_uri;
    const discoveryEvents = await database.pool.query(
      `SELECT count(*)::int count FROM system_events
       WHERE event='GSC_PROPERTY_MAPPED' AND detail->>'siteId'=$1`,
      [siteId],
    );
    expect(discoveryEvents.rows[0].count).toBe(0);
    await mapGscProperty(siteId, propertyId, database.db);
    const mappingEvents = await database.pool.query(
      `SELECT detail FROM system_events
       WHERE event='GSC_PROPERTY_MAPPED' AND detail->>'siteId'=$1`,
      [siteId],
    );
    expect(mappingEvents.rows).toEqual([
      {
        detail: {
          siteId,
          propertyUri: mappedPropertyUri,
          source: 'USER_SELECTED',
        },
      },
    ]);
  });
  afterAll(async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    await database.pool.end();
  });
  it('ingests 10K detailed rows, summarizes, and is idempotent', async () => {
    const first = await enqueueJob(
      { type: 'GSC_SYNC', siteId, mode: 'BOOTSTRAP_28D' },
      database.db,
    );
    expect(
      (await executeOne('gsc-e2e', database.pool, guard, new FakeSearchConsoleApi(10_000))).state,
    ).toBe('SUCCEEDED');
    const count1 = Number(
      (
        await database.pool.query(
          'SELECT count(*) count FROM gsc_query_page_metrics WHERE site_id=$1',
          [siteId],
        )
      ).rows[0].count,
    );
    expect(count1).toBe(10_027);
    const second = await enqueueJob({ type: 'GSC_SYNC', siteId, mode: 'INCREMENTAL' }, database.db);
    expect(second.heavy).toBe(false);
    expect(
      (await executeOne('gsc-e2e', database.pool, guard, new FakeSearchConsoleApi(10_000))).state,
    ).toBe('SUCCEEDED');
    const count2 = Number(
      (
        await database.pool.query(
          'SELECT count(*) count FROM gsc_query_page_metrics WHERE site_id=$1',
          [siteId],
        )
      ).rows[0].count,
    );
    expect(count2).toBe(count1);
    const view = await gscSiteView(siteId, {}, database.pool);
    expect(Number(view.summary.rows_stored)).toBeGreaterThan(10_000);
    expect(view.runs).toHaveLength(2);
    expect(view.connection).not.toHaveProperty('encrypted_refresh_token');
    expect(JSON.stringify(view)).not.toContain('refresh');
    expect(JSON.stringify(view)).not.toContain('access-secret');
    expect(first.type).toBe('GSC_SYNC');
  });
  it('rejects mismatched/replayed OAuth state and preserves good data after API failure', async () => {
    await createGscOAuthState(siteId, 'expected-hash', database.db);
    expect(await consumeGscOAuthState('wrong-hash', database.db)).toBeUndefined();
    expect(await consumeGscOAuthState('expected-hash', database.db)).toBeTruthy();
    expect(await consumeGscOAuthState('expected-hash', database.db)).toBeUndefined();
    await enqueueJob({ type: 'GSC_SYNC', siteId, mode: 'INCREMENTAL' }, database.db);
    expect(
      (
        await executeOne(
          'gsc-e2e',
          database.pool,
          guard,
          new FakeSearchConsoleApi(0, undefined, 'PERMISSION'),
        )
      ).state,
    ).toBe('FAILED');
    const view = await gscSiteView(siteId, {}, database.pool);
    expect(Number(view.summary.rows_stored)).toBeGreaterThan(10_000);
    expect(view.runs[0].failure_code).toBe('PROPERTY_ACCESS_LOST');
  });
  it('preserves metrics when disconnected and clears local credentials', async () => {
    await disconnectGsc(siteId, database.db);
    const credentials = await database.pool.query(
      'SELECT encrypted_refresh_token,encrypted_access_token,status FROM gsc_connections WHERE site_id=$1',
      [siteId],
    );
    expect(credentials.rows[0]).toEqual({
      encrypted_refresh_token: null,
      encrypted_access_token: null,
      status: 'DISCONNECTED',
    });
    expect(
      Number(
        (
          await database.pool.query(
            'SELECT count(*) count FROM gsc_query_page_metrics WHERE site_id=$1',
            [siteId],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(10_000);
  });
});
