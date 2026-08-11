import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertSafeTarget,
  controlledFetch,
  crawlSite,
  extractHtml,
  normalizeUrl,
  parseRobots,
  parseSitemapXml,
  robotsAllows,
} from '@seo-agent/crawler';
import { analyzePages, summarizeCrawl } from '@seo-agent/seo-engine';
import { startFixture } from './fixture-server';

describe('URL and network safety', () => {
  it('normalizes only safe technical equivalents and preserves slash distinction', () => {
    expect(normalizeUrl('HTTP://EXAMPLE.COM:80/a#x')).toBe('http://example.com/a');
    expect(normalizeUrl('https://example.com/page')).not.toBe(
      normalizeUrl('https://example.com/page/'),
    );
  });
  it.each([
    'http://127.0.0.1',
    'http://localhost',
    'http://169.254.169.254',
    'http://10.0.0.1',
    'http://172.20.0.1',
    'http://192.168.1.1',
    'http://[::1]',
  ])(`blocks %s`, async (url) => {
    await expect(assertSafeTarget(url)).rejects.toThrow('SSRF_BLOCKED');
  });
  it('allows private fixture targets only in explicit test mode', async () => {
    await expect(assertSafeTarget('http://127.0.0.1', false)).rejects.toThrow();
    await expect(assertSafeTarget('http://127.0.0.1', true)).resolves.toBeUndefined();
  });
  it('revalidates redirect destinations', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          }),
      ),
    );
    try {
      await expect(
        controlledFetch('https://example.com/', {
          timeoutMs: 1000,
          maxRedirects: 5,
          maxRetries: 0,
          maxBodyBytes: 1000,
          allowPrivateNetworkForTests: false,
        }),
      ).rejects.toThrow('SSRF_BLOCKED');
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });
});

describe('robots, sitemaps, extraction, and rules', () => {
  it('parses robots rules and sitemap declarations', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /private\nAllow: /private/public\nSitemap: https://example.com/sitemap.xml',
      200,
    );
    expect(robots.sitemaps).toHaveLength(1);
    expect(robotsAllows('/private/x', robots)).toBe(false);
    expect(robotsAllows('/private/public', robots)).toBe(true);
  });
  it('parses urlsets and sitemap indexes', () => {
    expect(parseSitemapXml('<urlset><url><loc>https://x/a</loc></url></urlset>')).toEqual({
      type: 'urlset',
      locations: ['https://x/a'],
    });
    expect(
      parseSitemapXml('<sitemapindex><sitemap><loc>https://x/s.xml</loc></sitemap></sitemapindex>')
        .type,
    ).toBe('index');
  });
  it('extracts structured SEO metadata without retaining HTML', () => {
    const page = extractHtml({
      html: '<html lang="en"><head><title>Example title</title><meta name="description" content="Description"><link rel="canonical" href="/a"><meta name="robots" content="noindex"><meta name="viewport" content="x"></head><body><h1>Main</h1><h2>Sub</h2><p>one two three</p><a href="/b">in</a><a href="https://outside.test">out</a></body></html>',
      requestedUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      statusCode: 200,
      redirectCount: 0,
      contentType: 'text/html',
      responseBytes: 100,
      responseTimeMs: 1,
      xRobotsTag: null,
      depth: 0,
      source: 'BASE',
      inSitemap: true,
    });
    expect(page).toMatchObject({
      title: 'Example title',
      metaDescription: 'Description',
      h1Count: 1,
      primaryH1: 'Main',
      h2Count: 1,
      canonicalUrl: 'https://example.com/a',
      indexable: false,
      wordCount: 3,
      externalLinksCount: 1,
      viewportPresent: true,
    });
    expect(page.contentHash).toHaveLength(64);
  });
  it('detects deterministic issues, duplicates, broken links, and summaries', () => {
    const base = {
      finalUrl: 'https://x/a',
      statusCode: 200,
      redirectCount: 0,
      contentType: 'text/html',
      responseBytes: 1,
      responseTimeMs: 1,
      title: null,
      titlePresent: false,
      titleLength: null,
      metaDescription: null,
      descriptionPresent: false,
      descriptionLength: null,
      h1Count: 0,
      primaryH1: null,
      h2Count: 0,
      canonicalUrl: null,
      canonicalCount: 0,
      robotsMeta: null,
      xRobotsTag: null,
      indexable: true,
      indexabilityReasons: ['INDEXABLE'] as 'INDEXABLE'[],
      wordCount: 2,
      externalLinksCount: 0,
      nofollowInternalCount: 0,
      contentHash: 'same',
      crawlDepth: 1,
      discoverySource: 'SITEMAP' as const,
      inSitemap: true,
      language: null,
      viewportPresent: false,
      fetchedAt: new Date(),
      fetchErrorCode: null,
      bodyTooLarge: false,
    };
    const pages = [
      { ...base, url: 'https://x/a', internalLinks: ['https://x/b'] },
      { ...base, url: 'https://x/b', finalUrl: 'https://x/b', statusCode: 404, internalLinks: [] },
    ];
    const issues = analyzePages(pages, new Set(pages.map((p) => p.url)));
    const codes = new Set(issues.map((i) => i.code));
    for (const code of [
      'TITLE_MISSING',
      'META_DESCRIPTION_MISSING',
      'H1_MISSING',
      'CANONICAL_MISSING',
      'VERY_LOW_WORD_COUNT',
      'HTML_LANG_MISSING',
      'VIEWPORT_MISSING',
      'HTTP_4XX',
      'BROKEN_INTERNAL_LINK',
      'DUPLICATE_CONTENT_HASH',
      'ORPHAN_CANDIDATE',
    ])
      expect(codes).toContain(code);
    expect(summarizeCrawl(pages, issues, 2, 10).http4xx).toBe(1);
  });
});

describe('bounded crawler integration', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => {
    fixture = await startFixture(510);
  });
  afterAll(async () => fixture.close());
  it('discovers sitemap indexes, links, robots blocks, redirects, errors, and issues', async () => {
    const crawl = await crawlSite({
      baseUrl: fixture.baseUrl,
      maxPages: 40,
      crawlDelayMs: 0,
      requestTimeoutMs: 1000,
      allowPrivateNetworkForTests: true,
    });
    expect(crawl.robots.fetched).toBe(true);
    expect(crawl.sitemapUrls.size).toBeGreaterThan(20);
    expect(crawl.pages.some((p) => p.fetchErrorCode === 'ROBOTS_BLOCKED')).toBe(true);
    expect(crawl.pages.some((p) => p.redirectCount === 2)).toBe(true);
    const codes = new Set(analyzePages(crawl.pages, crawl.sitemapUrls).map((i) => i.code));
    for (const code of [
      'TITLE_MISSING',
      'TITLE_DUPLICATE',
      'META_DESCRIPTION_MISSING',
      'H1_MULTIPLE',
      'H1_MISSING',
      'NOINDEX_PAGE',
      'BROKEN_INTERNAL_LINK',
      'HTTP_4XX',
      'HTTP_5XX',
      'DUPLICATE_CONTENT_HASH',
    ])
      expect(codes).toContain(code);
  });
  it('enforces the crawl limit and bounded cancellation', async () => {
    const limited = await crawlSite({
      baseUrl: fixture.baseUrl,
      maxPages: 3,
      crawlDelayMs: 0,
      requestTimeoutMs: 1000,
      allowPrivateNetworkForTests: true,
    });
    expect(limited.requested).toBe(3);
    let checks = 0;
    const cancelled = await crawlSite({
      baseUrl: fixture.baseUrl,
      maxPages: 100,
      crawlDelayMs: 0,
      requestTimeoutMs: 1000,
      allowPrivateNetworkForTests: true,
      shouldCancel: async () => ++checks > 4,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.requested).toBeLessThan(100);
  });
  it('handles timeout and bounded retry behavior', async () => {
    await expect(
      controlledFetch(`${fixture.baseUrl}slow`, {
        timeoutMs: 30,
        maxRedirects: 5,
        maxRetries: 0,
        maxBodyBytes: 1000,
        allowPrivateNetworkForTests: true,
      }),
    ).rejects.toThrow();
    const retried = await controlledFetch(`${fixture.baseUrl}retry`, {
      timeoutMs: 1000,
      maxRedirects: 5,
      maxRetries: 2,
      maxBodyBytes: 100000,
      allowPrivateNetworkForTests: true,
    });
    expect(retried.status).toBe(200);
  });
  it('crawls 100 generated pages with bounded retained data', async () => {
    const start = performance.now();
    const crawl = await crawlSite({
      baseUrl: fixture.baseUrl,
      maxPages: 100,
      crawlDelayMs: 0,
      requestTimeoutMs: 1000,
      allowPrivateNetworkForTests: true,
    });
    expect(crawl.requested).toBe(100);
    expect(crawl.pages.length).toBeLessThanOrEqual(101);
    expect(performance.now() - start).toBeLessThan(15000);
  });
  it('crawls 500 generated pages when practical', async () => {
    const crawl = await crawlSite({
      baseUrl: fixture.baseUrl,
      maxPages: 500,
      crawlDelayMs: 0,
      requestTimeoutMs: 1000,
      allowPrivateNetworkForTests: true,
    });
    expect(crawl.requested).toBe(500);
    expect(crawl.pages.length).toBeLessThanOrEqual(501);
  });
});
