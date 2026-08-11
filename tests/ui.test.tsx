import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gscSiteView, mapGscProperty } from '@seo-agent/database';

vi.mock('@seo-agent/database', () => ({
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
  listSites: vi.fn(async () => ({
    rows: [{ id: '1', name: 'Demo Site', url: 'https://example.com', active: true }],
    timingMs: 1,
  })),
  listJobs: vi.fn(async () => ({ rows: [], timingMs: 1 })),
  enqueueJob: vi.fn(),
  createSite: vi.fn(),
  requestJobCancellation: vi.fn(),
  mapGscProperty: vi.fn(),
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
