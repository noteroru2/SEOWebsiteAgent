import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  aiPanelForOpportunity,
  createDatabase,
  createSite,
  enqueueJob,
  loadRecommendationContext,
} from '@seo-agent/database';
import { buildProviderInput } from '@seo-agent/ai';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';
import { FakeAiProvider, type FakeAiMode } from './fake-ai-provider';

const database = createDatabase(requireTestDatabaseUrl());
const guard = new ResourceGuard(
  {},
  {
    collect: async () => ({
      freeMemoryMb: 2000,
      freeDiskMb: 20_000,
      loadPerCpu: 0,
      platform: 'linux',
    }),
  },
);
let siteId = '';
let opportunityId = '';
let propertyId = '';

async function seed() {
  const site = await createSite(
    { name: 'AI Fixture', url: 'https://ai.example.com/' },
    database.db,
  );
  siteId = site.id;
  const property = await database.pool.query(
    `INSERT INTO gsc_properties(property_uri,property_type,permission_level)
     VALUES('sc-domain:ai.example.com','DOMAIN','siteOwner') RETURNING id`,
  );
  propertyId = property.rows[0].id;
  const sync = await database.pool.query(
    `INSERT INTO gsc_sync_runs(site_id,property_id,mode,start_date,end_date,status,coverage_status,finished_at)
     VALUES($1,$2,'MANUAL_28D','2026-07-12','2026-08-08','SUCCEEDED','COMPLETE_AS_RETURNED',now()) RETURNING id`,
    [siteId, property.rows[0].id],
  );
  await database.pool.query(
    `INSERT INTO gsc_sync_summaries(site_id,property_id,last_sync_run_id,last_finalized_date,coverage_status,latest_status)
     VALUES($1,$2,$3,'2026-08-08','COMPLETE_AS_RETURNED','SUCCEEDED')`,
    [siteId, property.rows[0].id, sync.rows[0].id],
  );
  const generation = await database.pool.query(
    `INSERT INTO opportunity_runs(site_id,gsc_sync_reference,status,engine_version,finished_at)
     VALUES($1,$2,'SUCCEEDED','opportunity-engine-v1',now()) RETURNING id`,
    [siteId, sync.rows[0].id],
  );
  const opportunity = await database.pool.query(
    `INSERT INTO opportunities(site_id,kind,entity_type,url,query,title,summary,priority,priority_label,
      confidence,score,status,evidence,score_components,fingerprint,engine_version,generation_run_id)
     VALUES($1,'STRIKING_DISTANCE_QUERY','QUERY','https://ai.example.com/page','ตัวอย่างคำค้น',
      'Striking-distance query','Persisted deterministic evidence',3,'HIGH','MEDIUM',81,'OPEN',
      $2,'{}','ai-fixture-fingerprint','opportunity-engine-v1',$3) RETURNING id`,
    [
      siteId,
      JSON.stringify({
        current: { clicks: 12, impressions: 120, position: 8 },
        mappingReason: 'EXACT_URL',
        unknown: 'Intent is unknown.',
      }),
      generation.rows[0].id,
    ],
  );
  opportunityId = opportunity.rows[0].id;
  const repository = await database.pool.query(
    `INSERT INTO site_repositories(
       site_id,local_path,repository_type,enabled,head_sha,current_branch,
       worktree_clean,last_refreshed_at
     ) VALUES($1,'/fixtures/ai-source','LOCAL_GIT',true,$2,'main',true,now())
     RETURNING id`,
    [siteId, 'a'.repeat(40)],
  );
  await database.pool.query(
    `INSERT INTO source_route_mappings(
       site_id,repository_id,route_url,route_path,mapping_status,primary_source_path,
       repository_head_sha
     ) VALUES($1,$2,'https://ai.example.com/page','/page','EXACT_STATIC_ROUTE',
       'src/pages/page.astro',$3)`,
    [siteId, repository.rows[0].id, 'a'.repeat(40)],
  );
}

async function run(provider: FakeAiProvider, reanalyze = false) {
  const job = await enqueueJob(
    { type: 'ANALYZE_OPPORTUNITY', siteId, opportunityId, reanalyze },
    database.db,
  );
  const outcome = await executeOne('ai-test-worker', database.pool, guard, undefined, provider);
  return { job, outcome };
}

describe('AI recommendation worker pipeline', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    await seed();
  });
  afterAll(async () => database.pool.end());

  it('persists a strict recommendation and exact token/cost usage', async () => {
    const provider = new FakeAiProvider();
    const { job, outcome } = await run(provider);
    expect(outcome.state).toBe('SUCCEEDED');
    expect(provider.calls).toBe(1);
    const analysis = await database.pool.query('SELECT * FROM ai_analysis_runs WHERE job_id=$1', [
      job.id,
    ]);
    expect(analysis.rows[0]).toMatchObject({
      status: 'SUCCEEDED',
      model: 'gpt-5.6-terra',
      input_tokens: 800,
      cached_input_tokens: 200,
      output_tokens: 180,
      actual_cost_micros: 4250,
    });
    const recommendation = await database.pool.query(
      'SELECT * FROM ai_recommendations WHERE analysis_run_id=$1',
      [analysis.rows[0].id],
    );
    expect(recommendation.rows[0]).toMatchObject({ verdict: 'INVESTIGATE', confidence: 'MEDIUM' });
    expect(recommendation.rows[0].result.recommended_actions[0]).toMatchObject({
      action_type: 'REVIEW_SEARCH_INTENT',
      requires_human_review: true,
    });
    const usage = await database.pool.query('SELECT * FROM ai_usage WHERE analysis_run_id=$1', [
      analysis.rows[0].id,
    ]);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].provider_request_id).toBeUndefined();
  });

  it('loads the persisted current GSC window without inventing a previous window', async () => {
    const recommendation = await loadRecommendationContext(opportunityId, siteId, database.pool);
    expect(recommendation.search.currentWindow).toEqual({
      startDate: '2026-07-12',
      endDate: '2026-08-08',
      days: 28,
      dataState: 'SUCCEEDED',
      coverage: 'COMPLETE_AS_RETURNED',
    });
    expect(recommendation.search.previousWindow).toEqual({
      available: false,
      startDate: null,
      endDate: null,
      days: null,
    });
  });

  it('exposes a previous GSC window only when all persisted daily dates are available', async () => {
    await database.pool.query(
      `INSERT INTO gsc_daily_site_metrics(site_id,property_id,metric_date)
       SELECT $1,$2,date::date FROM generate_series('2026-06-14'::date,'2026-07-11'::date,'1 day') date`,
      [siteId, propertyId],
    );
    const recommendation = await loadRecommendationContext(opportunityId, siteId, database.pool);
    expect(recommendation.search.previousWindow).toEqual({
      available: true,
      startDate: '2026-06-14',
      endDate: '2026-07-11',
      days: 28,
    });
  });

  it('reuses identical evidence without a provider call and reanalyzes only explicitly', async () => {
    const provider = new FakeAiProvider();
    await run(provider);
    await run(provider);
    expect(provider.calls).toBe(1);
    let states = await database.pool.query(
      'SELECT status FROM ai_analysis_runs ORDER BY created_at',
    );
    expect(states.rows.map((row) => row.status)).toEqual(['SUCCEEDED', 'REUSED']);
    await run(provider, true);
    expect(provider.calls).toBe(2);
    states = await database.pool.query('SELECT status FROM ai_analysis_runs ORDER BY created_at');
    expect(states.rows.map((row) => row.status)).toEqual(['SUCCEEDED', 'REUSED', 'SUCCEEDED']);
  });

  it('allows a new analysis when persisted evidence changes', async () => {
    const provider = new FakeAiProvider();
    await run(provider);
    await database.pool.query(
      `UPDATE opportunities SET evidence=jsonb_set(evidence,'{current,impressions}',to_jsonb(121)) WHERE id=$1`,
      [opportunityId],
    );
    await run(provider);
    expect(provider.calls).toBe(2);
  });

  it('blocks before the provider when a hard budget would be exceeded', async () => {
    const previous = process.env.AI_MAX_ANALYSIS_COST_USD;
    process.env.AI_MAX_ANALYSIS_COST_USD = '0';
    try {
      const provider = new FakeAiProvider();
      const { outcome } = await run(provider);
      expect(outcome.state).toBe('FAILED');
      expect(provider.calls).toBe(0);
      const runState = await database.pool.query(
        'SELECT status,failure_code FROM ai_analysis_runs',
      );
      expect(runState.rows[0]).toMatchObject({
        status: 'FAILED',
        failure_code: 'AI_BUDGET_EXCEEDED',
      });
      expect((await database.pool.query('SELECT * FROM ai_usage')).rows).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.AI_MAX_ANALYSIS_COST_USD;
      else process.env.AI_MAX_ANALYSIS_COST_USD = previous;
    }
  });

  it('measures bounded context, persistence, UI query, memory, latency, and DB growth', async () => {
    const sizeBefore = Number(
      (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
    );
    const rssBefore = process.memoryUsage().rss;
    const contextStarted = performance.now();
    const context = await loadRecommendationContext(opportunityId, siteId, database.pool);
    const providerInput = buildProviderInput(context);
    const contextMs = performance.now() - contextStarted;
    const provider = new FakeAiProvider();
    const workerStarted = performance.now();
    const { job, outcome } = await run(provider);
    const workerMs = performance.now() - workerStarted;
    const uiStarted = performance.now();
    const panel = await aiPanelForOpportunity(opportunityId, database.pool);
    const uiQueryMs = performance.now() - uiStarted;
    const sizeAfter = Number(
      (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
    );
    const persisted = await database.pool.query('SELECT result FROM jobs WHERE id=$1', [job.id]);
    const measurement = {
      contextChars: providerInput.length,
      contextBuildMs: Math.round(contextMs * 10) / 10,
      workerMs: Math.round(workerMs * 10) / 10,
      workerRssGrowthMiB: Math.round(((process.memoryUsage().rss - rssBefore) / 1048576) * 10) / 10,
      providerLatencyMs: persisted.rows[0].result.latencyMs,
      uiQueryMs: Math.round(uiQueryMs * 10) / 10,
      dbGrowthBytes: sizeAfter - sizeBefore,
    };
    console.log('AI_RECOMMENDATION_PERF', JSON.stringify(measurement));
    expect(outcome.state).toBe('SUCCEEDED');
    expect(panel.latest?.status).toBe('SUCCEEDED');
    expect(measurement.contextChars).toBeLessThanOrEqual(24_000);
    expect(context.search.relatedSignals.length).toBeLessThanOrEqual(5);
  });

  for (const [mode, code, calls] of [
    ['timeout', 'AI_TIMEOUT', 1],
    ['429', 'AI_RATE_LIMITED', 1],
    ['5xx', 'AI_PROVIDER_ERROR', 1],
    ['auth', 'AI_AUTH_ERROR', 1],
    ['malformed', 'AI_SCHEMA_INVALID', 1],
  ] as Array<[FakeAiMode, string, number]>) {
    it(`records a safe ${mode} failure`, async () => {
      const provider = new FakeAiProvider(mode);
      const { job, outcome } = await run(provider);
      expect(outcome.state).toBe('FAILED');
      expect(provider.calls).toBe(calls);
      const failed = await database.pool.query(
        'SELECT failure_code,failure_summary FROM ai_analysis_runs WHERE job_id=$1',
        [job.id],
      );
      expect(failed.rows[0].failure_code).toBe(code);
      expect(JSON.stringify(failed.rows[0])).not.toContain('OPENAI_API_KEY');
      const usage = await database.pool.query(
        `SELECT status FROM ai_usage WHERE analysis_run_id=(SELECT id FROM ai_analysis_runs WHERE job_id=$1)`,
        [job.id],
      );
      expect(usage.rows).toHaveLength(calls);
      expect(usage.rows.every((row) => row.status === 'FAILED')).toBe(true);
    });
  }
});
