import type { ExtractedPage } from '@seo-agent/crawler';

export const SEO_THRESHOLDS = {
  titleMin: 30,
  titleMax: 60,
  descriptionMin: 70,
  descriptionMax: 160,
  veryLowWords: 100,
} as const;
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export interface SeoIssue {
  code: string;
  category: string;
  severity: Severity;
  url: string;
  summary: string;
  details?: Record<string, unknown>;
}

const issue = (
  page: ExtractedPage,
  code: string,
  category: string,
  severity: Severity,
  summary: string,
  details?: Record<string, unknown>,
): SeoIssue => ({ code, category, severity, url: page.url, summary, details });

export function analyzePages(pages: ExtractedPage[], sitemapUrls: Set<string>): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const incoming = new Map<string, number>();
  for (const page of pages)
    for (const link of page.internalLinks) incoming.set(link, (incoming.get(link) ?? 0) + 1);
  for (const page of pages) {
    if (page.fetchErrorCode === 'ROBOTS_BLOCKED')
      issues.push(
        issue(page, 'ROBOTS_BLOCKED', 'INDEXABILITY', 'INFO', 'URL was blocked by robots.txt'),
      );
    if (page.fetchErrorCode === 'REDIRECT_LOOP')
      issues.push(
        issue(page, 'REDIRECT_LOOP', 'HTTP', 'HIGH', 'Redirect loop prevented retrieval'),
      );
    if ((page.statusCode ?? 0) >= 400 && (page.statusCode ?? 0) < 500)
      issues.push(issue(page, 'HTTP_4XX', 'HTTP', 'HIGH', `URL returned HTTP ${page.statusCode}`));
    if ((page.statusCode ?? 0) >= 500)
      issues.push(issue(page, 'HTTP_5XX', 'HTTP', 'HIGH', `URL returned HTTP ${page.statusCode}`));
    if (page.redirectCount > 1)
      issues.push(
        issue(
          page,
          'REDIRECT_CHAIN',
          'HTTP',
          'MEDIUM',
          `URL followed ${page.redirectCount} redirects`,
        ),
      );
    if (page.statusCode === 200 && /^text\/html/i.test(page.contentType ?? '')) {
      if (!page.titlePresent)
        issues.push(issue(page, 'TITLE_MISSING', 'TITLE', 'HIGH', 'HTML title element is missing'));
      else if (!page.title)
        issues.push(issue(page, 'TITLE_EMPTY', 'TITLE', 'HIGH', 'HTML title element is empty'));
      else if (page.title.length < SEO_THRESHOLDS.titleMin)
        issues.push(
          issue(
            page,
            'TITLE_TOO_SHORT',
            'TITLE',
            'LOW',
            'Title is shorter than the configured heuristic',
          ),
        );
      else if (page.title.length > SEO_THRESHOLDS.titleMax)
        issues.push(
          issue(
            page,
            'TITLE_TOO_LONG',
            'TITLE',
            'LOW',
            'Title is longer than the configured heuristic',
          ),
        );
      if (!page.descriptionPresent)
        issues.push(
          issue(
            page,
            'META_DESCRIPTION_MISSING',
            'DESCRIPTION',
            'MEDIUM',
            'Meta description is missing',
          ),
        );
      else if (!page.metaDescription)
        issues.push(
          issue(
            page,
            'META_DESCRIPTION_EMPTY',
            'DESCRIPTION',
            'MEDIUM',
            'Meta description is empty',
          ),
        );
      else if (page.metaDescription.length < SEO_THRESHOLDS.descriptionMin)
        issues.push(
          issue(
            page,
            'META_DESCRIPTION_TOO_SHORT',
            'DESCRIPTION',
            'LOW',
            'Meta description is shorter than the configured heuristic',
          ),
        );
      else if (page.metaDescription.length > SEO_THRESHOLDS.descriptionMax)
        issues.push(
          issue(
            page,
            'META_DESCRIPTION_TOO_LONG',
            'DESCRIPTION',
            'LOW',
            'Meta description is longer than the configured heuristic',
          ),
        );
      if (!page.h1Count)
        issues.push(issue(page, 'H1_MISSING', 'HEADINGS', 'MEDIUM', 'Page has no H1'));
      if (page.h1Count > 1)
        issues.push(
          issue(page, 'H1_MULTIPLE', 'HEADINGS', 'LOW', `Page has ${page.h1Count} H1 elements`),
        );
      if (page.h1Count && !page.primaryH1)
        issues.push(issue(page, 'H1_EMPTY', 'HEADINGS', 'LOW', 'Primary H1 is empty'));
      if (!page.canonicalCount)
        issues.push(
          issue(page, 'CANONICAL_MISSING', 'CANONICAL', 'LOW', 'Canonical link is missing'),
        );
      if (page.canonicalCount > 1)
        issues.push(
          issue(
            page,
            'CANONICAL_MULTIPLE',
            'CANONICAL',
            'MEDIUM',
            'Multiple canonical links were found',
          ),
        );
      if (page.canonicalCount && !page.canonicalUrl)
        issues.push(
          issue(page, 'CANONICAL_INVALID', 'CANONICAL', 'MEDIUM', 'Canonical URL is invalid'),
        );
      if (
        page.canonicalUrl &&
        new URL(page.canonicalUrl).hostname !== new URL(page.finalUrl).hostname
      )
        issues.push(
          issue(
            page,
            'CANONICAL_EXTERNAL',
            'CANONICAL',
            'MEDIUM',
            'Canonical points to another hostname',
          ),
        );
      if (page.canonicalUrl && page.canonicalUrl !== page.finalUrl)
        issues.push(
          issue(
            page,
            'CANONICAL_SELF_MISMATCH',
            'CANONICAL',
            'LOW',
            'Canonical differs from the fetched URL',
          ),
        );
      if (/\bnoindex\b/i.test(page.robotsMeta ?? ''))
        issues.push(
          issue(page, 'NOINDEX_PAGE', 'INDEXABILITY', 'INFO', 'Meta robots contains noindex'),
        );
      if (/\bnoindex\b/i.test(page.xRobotsTag ?? ''))
        issues.push(
          issue(page, 'X_ROBOTS_NOINDEX', 'INDEXABILITY', 'INFO', 'X-Robots-Tag contains noindex'),
        );
      if (page.wordCount < SEO_THRESHOLDS.veryLowWords)
        issues.push(
          issue(page, 'VERY_LOW_WORD_COUNT', 'CONTENT', 'LOW', 'Page has very little primary text'),
        );
      if (!page.language)
        issues.push(
          issue(page, 'HTML_LANG_MISSING', 'TECHNICAL', 'LOW', 'HTML lang attribute is missing'),
        );
      if (!page.viewportPresent)
        issues.push(
          issue(page, 'VIEWPORT_MISSING', 'TECHNICAL', 'LOW', 'Viewport meta tag is missing'),
        );
    }
    for (const link of page.internalLinks) {
      const target = byUrl.get(link);
      if (target && (target.statusCode ?? 0) >= 400)
        issues.push(
          issue(
            page,
            'BROKEN_INTERNAL_LINK',
            'LINKS',
            'HIGH',
            `Internal link targets HTTP ${target.statusCode}`,
            { target: link },
          ),
        );
      else if (target && target.redirectCount > 0)
        issues.push(
          issue(page, 'INTERNAL_LINK_REDIRECT', 'LINKS', 'LOW', 'Internal link redirects', {
            target: link,
          }),
        );
    }
    if (page.canonicalUrl) {
      const canonical = byUrl.get(page.canonicalUrl);
      if (canonical && canonical.statusCode !== 200)
        issues.push(
          issue(page, 'CANONICAL_NON_200', 'CANONICAL', 'HIGH', 'Canonical target is not HTTP 200'),
        );
      if (canonical && canonical.redirectCount > 0)
        issues.push(
          issue(page, 'CANONICAL_REDIRECT', 'CANONICAL', 'MEDIUM', 'Canonical target redirects'),
        );
    }
    if (page.inSitemap && (page.statusCode !== 200 || page.redirectCount > 0))
      issues.push(
        issue(
          page,
          page.redirectCount ? 'SITEMAP_URL_REDIRECT' : 'SITEMAP_URL_NON_200',
          'SITEMAP',
          'MEDIUM',
          'Sitemap URL did not resolve directly to HTTP 200',
        ),
      );
    if (page.inSitemap && !page.indexable)
      issues.push(
        issue(page, 'SITEMAP_URL_NOINDEX', 'SITEMAP', 'MEDIUM', 'Sitemap URL is not indexable'),
      );
    if (page.indexable && !page.inSitemap)
      issues.push(
        issue(
          page,
          'INDEXABLE_URL_NOT_IN_SITEMAP',
          'SITEMAP',
          'INFO',
          'Indexable URL was not found in a sitemap',
        ),
      );
    if (
      page.inSitemap &&
      page.indexable &&
      (incoming.get(page.url) ?? 0) === 0 &&
      page.discoverySource === 'SITEMAP'
    )
      issues.push(
        issue(
          page,
          'ORPHAN_CANDIDATE',
          'LINKS',
          'MEDIUM',
          'Sitemap URL received no internal links in this bounded crawl',
        ),
      );
  }
  addDuplicates(pages, issues, 'title', 'TITLE_DUPLICATE', 'TITLE');
  addDuplicates(pages, issues, 'metaDescription', 'META_DESCRIPTION_DUPLICATE', 'DESCRIPTION');
  addDuplicates(pages, issues, 'contentHash', 'DUPLICATE_CONTENT_HASH', 'CONTENT');
  for (const url of sitemapUrls)
    if (!byUrl.has(url))
      issues.push({
        code: 'SITEMAP_URL_NOT_DISCOVERED',
        category: 'SITEMAP',
        severity: 'INFO',
        url,
        summary: 'Sitemap URL was outside this bounded crawl result',
      });
  return issues;
}

function addDuplicates(
  pages: ExtractedPage[],
  issues: SeoIssue[],
  field: 'title' | 'metaDescription' | 'contentHash',
  code: string,
  category: string,
) {
  const groups = new Map<string, ExtractedPage[]>();
  for (const page of pages) {
    const value = page[field];
    if (!value) continue;
    const key = value.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(page);
    groups.set(key, list);
  }
  for (const group of groups.values())
    if (group.length > 1)
      for (const page of group)
        issues.push(
          issue(
            page,
            code,
            category,
            'MEDIUM',
            `${field} is shared by ${group.length} crawled URLs`,
          ),
        );
}

export function summarizeCrawl(
  pages: ExtractedPage[],
  issues: SeoIssue[],
  discovered: number,
  durationMs: number,
) {
  const status = (min: number, max: number) =>
    pages.filter((page) => (page.statusCode ?? 0) >= min && (page.statusCode ?? 0) <= max).length;
  const severity = (value: Severity) => issues.filter((item) => item.severity === value).length;
  const code = (value: string) => issues.filter((item) => item.code === value).length;
  return {
    totalDiscovered: discovered,
    totalCrawled: pages.length,
    http2xx: status(200, 299),
    http3xx: status(300, 399),
    http4xx: status(400, 499),
    http5xx: status(500, 599),
    indexable: pages.filter((page) => page.indexable).length,
    nonIndexable: pages.filter((page) => !page.indexable).length,
    issues: issues.length,
    issuesBySeverity: {
      critical: severity('CRITICAL'),
      high: severity('HIGH'),
      medium: severity('MEDIUM'),
      low: severity('LOW'),
      info: severity('INFO'),
    },
    missingTitles: code('TITLE_MISSING'),
    missingH1: code('H1_MISSING'),
    canonicalProblems: issues.filter((item) => item.category === 'CANONICAL').length,
    brokenInternalLinks: code('BROKEN_INTERNAL_LINK'),
    durationMs,
  };
}
