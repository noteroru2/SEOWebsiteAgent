import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gscSiteView, mapGscProperty } from '@seo-agent/database';

vi.mock('@seo-agent/database', () => ({
  siteSourceSummary: vi.fn(async () => null),
  sourcePanelForOpportunity: vi.fn(async () => ({
    configured: true,
    activeJob: null,
    mapping: null,
    latest: null,
  })),
  evidencePanelForOpportunity: vi.fn(async () => ({
    completeness: 'OWNER_INPUT_REQUIRED',
    requests: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'MANUAL_SERP_OBSERVATION',
        requirement: 'Observe the current result.',
        reason: 'The API does not provide the displayed snippet.',
        status: 'OPEN',
        source: 'OWNER',
        items: [],
      },
    ],
  })),
  listSourceApprovals: vi.fn(async () => ({ rows: [], timingMs: 1 })),
  connectSourceRepository: vi.fn(),
  decideSourcePlan: vi.fn(),
  aiSpendSummary: vi.fn(async () => ({
    analyses: 1,
    provider_calls: 1,
    average_cost_micros: 4250,
    cost_micros: 4250,
    budgetMicros: 8_500_000,
  })),
  aiPanelForOpportunity: vi.fn(async () => ({
    configured: true,
    activeJob: null,
    latest: {
      status: 'SUCCEEDED',
      verdict: 'INVESTIGATE',
      recommendation_confidence: 'MEDIUM',
      recommendation_summary: 'Review intent before changing the page.',
      actual_cost_micros: 4250,
      model: 'gpt-5.6-terra',
      prompt_version: 'seo-recommendation-prompt-v1',
      schema_version: 'seo-recommendation-schema-v1',
      finished_at: new Date(),
      latency_ms: 25,
      result: {
        evidence_used: [{ type: 'GSC', fact: '200 impressions at position 8.' }],
        recommended_actions: [
          {
            action_type: 'REVIEW_SEARCH_INTENT',
            title: 'Review intent',
            description: 'Owner review only.',
            risk: 'LOW',
            expected_goal: 'Confirm query ownership.',
            requires_human_review: true,
          },
        ],
        unknowns: ['SERP features are unknown.'],
        additional_evidence_needed: ['Review body content.'],
        do_not_do: ['Do not promise rankings.'],
      },
    },
  })),
  dashboardSummary: vi.fn(async () => ({
    sites: 1,
    running: 0,
    pending: 0,
    queued: 0,
    aiCostMicros: 0,
    workerHealthy: true,
    recentJobs: [],
    timingMs: 1,
  })),
  databaseHealthy: vi.fn(async () => true),
  dashboardTopOpportunities: vi.fn(async () => ({
    rows: [
      {
        id: 'opp-1',
        kind: 'STRIKING_DISTANCE_QUERY',
        priority_label: 'HIGH',
        score: 82,
        site_name: 'Fixture Site',
      },
    ],
    timingMs: 1,
  })),
  listSites: vi.fn(async () => ({
    rows: [{ id: '1', name: 'Demo Site', url: 'https://example.com', active: true }],
    timingMs: 1,
  })),
  listJobs: vi.fn(async () => ({ rows: [], timingMs: 1 })),
  enqueueJob: vi.fn(),
  createSite: vi.fn(),
  requestJobCancellation: vi.fn(),
  mapGscProperty: vi.fn(),
  dismissOpportunity: vi.fn(),
  listOpportunities: vi.fn(async () => ({
    rows: [
      {
        id: '11111111-1111-4111-8111-111111111112',
        site_id: '11111111-1111-4111-8111-111111111111',
        site_name: 'Fixture Site',
        kind: 'STRIKING_DISTANCE_QUERY',
        entity_type: 'QUERY_PAGE',
        url: 'https://example.com/page',
        query: 'seo query',
        title: 'Query within striking distance',
        summary: 'Meaningful demand',
        priority_label: 'HIGH',
        confidence: 'HIGH',
        score: 82,
        status: 'OPEN',
        evidence: { currentImpressions: 200, currentPosition: 8 },
      },
    ],
    counts: { HIGH: 1, MEDIUM: 0, LOW: 0 },
    sites: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Fixture Site' }],
    timingMs: 2,
  })),
  opportunityDetail: vi.fn(async () => ({
    opportunity: {
      id: '11111111-1111-4111-8111-111111111112',
      site_id: '11111111-1111-4111-8111-111111111111',
      site_name: 'Fixture Site',
      kind: 'STRIKING_DISTANCE_QUERY',
      url: 'https://example.com/page',
      query: 'seo query',
      title: 'Query within striking distance',
      summary: 'Meaningful demand',
      priority_label: 'HIGH',
      confidence: 'HIGH',
      score: 82,
      status: 'OPEN',
      evidence: { currentImpressions: 200, unknown: 'Causation is unknown.' },
      score_components: {
        demand: 30,
        potential: 20,
        evidenceStrength: 17,
        mappingConfidence: 15,
        total: 82,
      },
      first_detected_at: new Date(),
      last_detected_at: new Date(),
      engine_version: 'opportunity-engine-v1',
    },
    relatedIssues: [],
    relatedGsc: { clicks: 10, impressions: 200, ctr: 0.05, position: 8 },
    timingMs: 2,
  })),
  siteOpportunitySummary: vi.fn(async () => ({
    counts: { open: 1, high: 1, medium: 0, low: 0 },
    top: [{ id: 'opp-1', kind: 'STRIKING_DISTANCE_QUERY', priority_label: 'HIGH', score: 82 }],
    latestRun: { status: 'SUCCEEDED' },
    activeJob: null,
    timingMs: 1,
  })),
  getSite: vi.fn(async () => ({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Fixture Site',
    url: 'https://example.com/',
  })),
  gscSiteView: vi.fn(async () => ({
    connection: { id: 'connection', status: 'CONNECTED' },
    properties: [
      {
        id: 'property',
        property_uri: 'sc-domain:example.com',
        permission_level: 'siteOwner',
        selected: true,
      },
    ],
    summary: {
      current_metrics: { clicks: 10, impressions: 100, ctr: 0.1, position: 4 },
      previous_metrics: {},
      deltas: {},
      coverage_status: 'COMPLETE_AS_RETURNED',
      rows_stored: 20,
      last_finalized_date: new Date(2026, 7, 8),
    },
    runs: [
      {
        id: 'run',
        status: 'SUCCEEDED',
        mode: 'INCREMENTAL',
        start_date: new Date(2026, 7, 6),
        end_date: new Date(2026, 7, 8),
        api_requests: 12,
        rows_received: 874,
        coverage_status: 'COMPLETE_AS_RETURNED',
      },
    ],
    queries: [{ query: 'seo', clicks: 10, impressions: 100, ctr: 0.1, position: 4 }],
    pages: [],
    queryPages: [
      {
        metric_date: new Date(2026, 7, 8),
        query: 'seo',
        page: 'https://example.com/',
        clicks: 1,
        impressions: 10,
      },
    ],
    timingMs: 2,
  })),
  gscSiteStatus: vi.fn(async () => ({
    status: 'CONNECTED',
    property_uri: 'sc-domain:example.com',
    latest_status: 'SUCCEEDED',
    last_sync_at: new Date('2026-08-08'),
  })),
  siteDetail: vi.fn(async () => ({
    site: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Fixture Site',
      url: 'https://example.com/',
      active: true,
      crawlEnabled: true,
      maxPages: 500,
      crawlDelayMs: 300,
      requestTimeoutMs: 10000,
    },
    latest: {
      status: 'SUCCEEDED',
      pagesCrawled: 20,
      pagesIndexable: 15,
      pagesDiscovered: 22,
      issuesFound: 4,
      durationMs: 100,
      startedAt: new Date(),
      summary: { http4xx: 1, http5xx: 0 },
    },
    issues: [
      {
        id: 'issue-1',
        severity: 'HIGH',
        ruleCode: 'TITLE_MISSING',
        url: 'https://example.com/missing',
        title: 'HTML title element is missing',
      },
    ],
    runningJob: null,
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
describe('server-rendered UI foundations', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders dashboard', async () => {
    const Page = (await import('../apps/web/app/page')).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Dashboard');
    expect(html).toContain('System health');
    expect(html).toContain('Top Opportunities');
  });
  it('renders site list', async () => {
    const Page = (await import('../apps/web/app/sites/page')).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Demo Site');
  });
  it('renders jobs list', async () => {
    const Page = (await import('../apps/web/app/jobs/page')).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Enqueue SYSTEM_TEST');
  });
  it('renders compact crawl summary and bounded issues', async () => {
    const Page = (await import('../apps/web/app/sites/[id]/page')).default;
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('Pages crawled');
    expect(html).toContain('TITLE_MISSING');
    expect(html).toContain('Orphan candidates');
    expect(html).toContain('2026-08-08 00:00:00 UTC');
    expect(html).toContain('Generate Opportunities');
    expect(html).toContain('SEO Opportunities');
  });
  it('renders bounded opportunity overview and deterministic detail', async () => {
    const Overview = (await import('../apps/web/app/opportunities/page')).default;
    const overview = renderToStaticMarkup(await Overview({ searchParams: Promise.resolve({}) }));
    expect(overview).toContain('SEO Opportunities');
    expect(overview).toContain('STRIKING_DISTANCE_QUERY');
    expect(overview).toContain('bounded to 100 records');

    const Detail = (await import('../apps/web/app/opportunities/[id]/page')).default;
    const detail = renderToStaticMarkup(
      await Detail({
        params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111112' }),
      }),
    );
    expect(detail).toContain('Structured evidence');
    expect(detail).toContain('What the system does not know');
    expect(detail).toContain('opportunity-engine-v1');
    expect(detail).toContain('SEO recommendation');
    expect(detail).toContain('REVIEW_SEARCH_INTENT');
    expect(detail).toContain('HUMAN REVIEW REQUIRED');
    expect(detail).toContain('EVIDENCE REQUIRED');
    expect(detail).toContain('Add SERP Observation');
    expect(detail).not.toContain('OPENAI_API_KEY=');
  });
  it('renders bounded GSC data without credential material', async () => {
    const Page = (await import('../apps/web/app/sites/[id]/search-console/page')).default;
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('sc-domain:example.com');
    expect(html).toContain('28d clicks');
    expect(html).toContain('Last finalized date: 2026-08-08');
    expect(html).toContain('2026-08-06 – 2026-08-08');
    expect(html).not.toContain('refresh_token');
    expect(html).not.toContain('access_token');
    expect(mapGscProperty).not.toHaveBeenCalled();
  });
  it('server-renders a fresh connected GSC site while its first sync is queued', async () => {
    vi.mocked(gscSiteView).mockResolvedValueOnce({
      connection: { id: 'connection', status: 'CONNECTED' },
      properties: [
        {
          id: 'property',
          property_uri: 'sc-domain:example.com',
          permission_level: 'siteOwner',
          selected: true,
        },
      ],
      summary: null,
      latestJob: {
        status: 'QUEUED',
        mode: 'INCREMENTAL',
        failure_code: null,
        failure_summary: null,
      },
      runs: [],
      queries: [],
      pages: [],
      queryPages: [],
      timingMs: 1,
    } as never);
    const Page = (await import('../apps/web/app/sites/[id]/search-console/page')).default;

    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain('Sync status: QUEUED');
    expect(html).toContain('A Search Console sync is queued.');
    expect(html).not.toContain('Bootstrap 28 Days');
    expect(html).not.toContain('Sync Now');
  });
  it.each([
    'NOT_CONNECTED',
    'CONNECTED_NO_SYNC',
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'PARTIAL',
    'FAILED',
    'CANCELLED',
  ])('server-renders the %s GSC transitional state', async (status) => {
    const connected = status !== 'NOT_CONNECTED';
    const jobStatus = ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'].includes(status) ? status : null;
    const runStatus = ['SUCCEEDED', 'PARTIAL'].includes(status) ? status : null;
    vi.mocked(gscSiteView).mockResolvedValueOnce({
      connection: connected ? { id: 'connection', status: 'CONNECTED' } : null,
      properties: connected
        ? [
            {
              id: 'property',
              property_uri: 'sc-domain:example.com',
              permission_level: 'siteOwner',
              selected: true,
            },
          ]
        : [],
      summary: null,
      latestJob: jobStatus
        ? {
            status: jobStatus,
            mode: 'BOOTSTRAP_28D',
            failure_code: status === 'FAILED' ? 'GOOGLE_API_ERROR' : null,
            failure_summary: null,
          }
        : null,
      runs: runStatus
        ? [
            {
              id: 'run',
              status: runStatus,
              mode: 'BOOTSTRAP_28D',
              start_date: null,
              end_date: null,
              api_requests: 0,
              rows_received: 0,
              coverage_status: runStatus === 'PARTIAL' ? 'POSSIBLY_TRUNCATED' : null,
            },
          ]
        : [],
      queries: [],
      pages: [],
      queryPages: [],
      timingMs: 1,
    } as never);
    const Page = (await import('../apps/web/app/sites/[id]/search-console/page')).default;

    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain('Google Search Console');
    if (status === 'NOT_CONNECTED') expect(html).toContain('Status: Not connected');
    else expect(html).toContain(`Sync status: ${status}`);
  });
});
