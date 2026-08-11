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
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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
});
