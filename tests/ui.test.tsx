import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  });
});
