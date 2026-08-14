import type { Pool } from 'pg';

const TEST_DATABASE_SUFFIX = '_test';
const TEST_DATABASE_MARKER = 'SEO_AGENT_TEST_DATABASE';

type TestDatabaseOptions = {
  nodeEnv?: string;
  developmentDatabaseUrl?: string;
  requireNodeEnv?: boolean;
};

export function validateTestDatabaseUrl(
  value: string | undefined,
  options: TestDatabaseOptions = {},
) {
  if (!value) throw new Error('TEST_DATABASE_URL is required for database-backed tests.');
  if (options.requireNodeEnv !== false && options.nodeEnv !== 'test')
    throw new Error('NODE_ENV=test is required for destructive database-backed tests.');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('TEST_DATABASE_URL must use PostgreSQL.');

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(databaseName) || !databaseName.endsWith(TEST_DATABASE_SUFFIX))
    throw new Error('TEST_DATABASE_URL must target a database whose name ends in _test.');
  if (databaseName === 'seo_agent')
    throw new Error('The development seo_agent database is never a valid test target.');

  if (options.developmentDatabaseUrl) {
    const development = new URL(options.developmentDatabaseUrl);
    const sameServer =
      parsed.hostname === development.hostname &&
      (parsed.port || '5432') === (development.port || '5432');
    const developmentName = decodeURIComponent(development.pathname.replace(/^\//, ''));
    if (sameServer && databaseName === developmentName)
      throw new Error('TEST_DATABASE_URL must not target DATABASE_URL.');
  }

  return { url: value, databaseName };
}

export function requireTestDatabaseUrl() {
  return validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, {
    nodeEnv: process.env.NODE_ENV,
    developmentDatabaseUrl: process.env.DATABASE_URL,
  }).url;
}

export async function assertTestDatabaseConnection(pool: Pool) {
  const expected = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, {
    nodeEnv: process.env.NODE_ENV,
    developmentDatabaseUrl: process.env.DATABASE_URL,
  });
  const result = await pool.query<{ database_name: string; guard_table: string | null }>(
    `SELECT current_database() database_name,
      to_regclass('public.test_database_guard')::text guard_table`,
  );
  const actual = result.rows[0];
  if (actual?.database_name !== expected.databaseName)
    throw new Error('Connected database does not match TEST_DATABASE_URL.');
  if (!actual.guard_table)
    throw new Error('Test database marker is missing; run npm run db:test:prepare.');
  const marker = await pool.query<{ marker: string }>(
    'SELECT marker FROM test_database_guard LIMIT 1',
  );
  if (marker.rows[0]?.marker !== TEST_DATABASE_MARKER)
    throw new Error('Test database marker is invalid; destructive reset refused.');
  return actual.database_name;
}

export async function resetTestDatabase(pool: Pool) {
  await assertTestDatabaseConnection(pool);
  await pool.query(`TRUNCATE
    patch_workflow_audit_events,patch_rollbacks,patch_releases,patch_validations,patch_workspace_runs,patch_approvals,patch_previews,patch_workflows,source_change_plans,source_plan_runs,
    serp_provider_reservations,serp_api_captures,serp_location_profiles,serp_provider_usage_periods,serp_provider_configs,
    browser_capture_tokens,serp_captures,evidence_items,evidence_requests,owner_research_findings,owner_research_source_links,
    owner_research_fact_links,owner_research_requests,owner_research_cases,owner_fact_confirmation_links,owner_facts,owner_fact_confirmations,
    opportunity_runs,
    gsc_page_crawl_mappings,gsc_sync_summaries,gsc_query_page_metrics,gsc_page_metrics,
    gsc_query_metrics,gsc_daily_site_metrics,gsc_sync_runs,site_gsc_properties,gsc_properties,
    gsc_oauth_states,gsc_connections,system_events,ai_usage,approvals,opportunities,seo_issues,
    crawl_pages,crawl_runs,job_events,jobs,site_repositories,sites
    CASCADE`);
}

export const testDatabaseMarker = TEST_DATABASE_MARKER;

export function isProductionDatabaseUrl(connectionString?: string): boolean {
  const urlStr = connectionString || process.env.DATABASE_URL || '';
  if (!urlStr) return process.env.NODE_ENV === 'production';
  try {
    const parsed = new URL(urlStr);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    const isProdDbName = databaseName === 'seo_agent';
    const isProdHost =
      parsed.hostname === '195.201.94.169' ||
      parsed.hostname === 'seo.amphontd.com' ||
      parsed.hostname === 'amphon-app-prod';
    const isProdAppUrl =
      process.env.APP_BASE_URL === 'https://seo.amphontd.com' ||
      process.env.APP_BASE_URL === 'https://seo.amphon.co.th';
    const isProdEnv = process.env.NODE_ENV === 'production';
    return isProdEnv || isProdDbName || isProdHost || isProdAppUrl;
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}

export function assertFixtureSafeDatabase(options?: { context?: string }) {
  const isProd = isProductionDatabaseUrl();
  const contextMsg = options?.context || 'fixture/seed execution';

  if (isProd) {
    throw new Error(
      `FIXTURE_GUARD_BLOCKED: Fixture/seed/scratch database mutation is strictly prohibited against production environment or production database 'seo_agent' (${contextMsg}).`,
    );
  }

  if (process.env.ALLOW_FIXTURE_DATA !== 'true') {
    throw new Error(
      `FIXTURE_GUARD_BLOCKED: Fixture/seed operations require ALLOW_FIXTURE_DATA=true in development/test environment (${contextMsg}).`,
    );
  }
}
