import { controlledFetch } from './http';
import { extractHtml, classifyIndexability } from './extract';
import { parseRobots, parseSitemapXml, robotsAllows } from './robots';
import { isLikelyCrawlTrap, isSameSite, normalizeUrl } from './url';
import type {
  CrawlOptions,
  CrawlResult,
  DiscoverySource,
  ExtractedPage,
  RobotsResult,
} from './types';

export * from './types';
export * from './url';
export * from './robots';
export * from './extract';
export * from './http';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const started = performance.now();
  const baseUrl = normalizeUrl(options.baseUrl);
  const maxPages = Math.min(Math.max(options.maxPages, 1), 5000);
  const maxQueue = Math.min(options.maxQueueSize ?? maxPages * 10, 25_000);
  const common = {
    timeoutMs: options.requestTimeoutMs,
    maxRedirects: options.maxRedirects ?? 5,
    maxRetries: options.maxRetries ?? 2,
    maxBodyBytes: options.maxBodyBytes ?? 5 * 1024 * 1024,
    allowPrivateNetworkForTests: options.allowPrivateNetworkForTests ?? false,
  };
  let robots: RobotsResult;
  try {
    const response = await controlledFetch(new URL('/robots.txt', baseUrl).toString(), {
      ...common,
      maxBodyBytes: 512 * 1024,
    });
    robots = parseRobots(response.body ?? '', response.status, response.durationMs);
  } catch {
    robots = parseRobots('', null, 0);
  }

  const sitemapUrls = new Set<string>();
  const sitemapQueue = [...robots.sitemaps, new URL('/sitemap.xml', baseUrl).toString()];
  const visitedSitemaps = new Set<string>();
  while (sitemapQueue.length && visitedSitemaps.size < 50 && sitemapUrls.size < maxQueue) {
    const sitemap = sitemapQueue.shift()!;
    let normalized: string;
    try {
      normalized = normalizeUrl(sitemap, baseUrl);
    } catch {
      continue;
    }
    if (!isSameSite(normalized, baseUrl) || visitedSitemaps.has(normalized)) continue;
    visitedSitemaps.add(normalized);
    try {
      const response = await controlledFetch(normalized, {
        ...common,
        maxBodyBytes: 5 * 1024 * 1024,
        acceptXml: true,
      });
      if (response.status !== 200 || !response.body) continue;
      const parsed = parseSitemapXml(response.body);
      for (const location of parsed.locations) {
        let value: string;
        try {
          value = normalizeUrl(location, normalized);
        } catch {
          continue;
        }
        if (!isSameSite(value, baseUrl)) continue;
        if (parsed.type === 'index') sitemapQueue.push(value);
        else sitemapUrls.add(value);
        if (sitemapUrls.size >= maxQueue) break;
      }
    } catch {
      /* sitemap discovery is best effort */
    }
  }

  const queued = new Map<string, { depth: number; source: DiscoverySource }>();
  const seen = new Set<string>();
  const variantsByPath = new Map<string, number>();
  const enqueue = (url: string, depth: number, source: DiscoverySource) => {
    const parsed = new URL(url);
    const pathKey = `${parsed.origin}${parsed.pathname}`;
    const variants = variantsByPath.get(pathKey) ?? 0;
    if (
      queued.size + seen.size >= maxQueue ||
      seen.has(url) ||
      queued.has(url) ||
      !isSameSite(url, baseUrl) ||
      isLikelyCrawlTrap(url) ||
      variants >= 10
    )
      return;
    variantsByPath.set(pathKey, variants + 1);
    queued.set(url, { depth, source });
  };
  enqueue(baseUrl, 0, 'BASE');
  for (const url of sitemapUrls) enqueue(url, 0, 'SITEMAP');
  const pages: ExtractedPage[] = [];
  let requested = 0;
  let cancelled = false;
  let lastRequest = 0;
  while (queued.size && requested < maxPages) {
    if (await options.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const next = queued.entries().next().value as
      [string, { depth: number; source: DiscoverySource }] | undefined;
    if (!next) break;
    const [url, metadata] = next;
    queued.delete(url);
    seen.add(url);
    if (!robotsAllows(new URL(url).pathname, robots)) {
      const indexability = classifyIndexability(null, null, null, true);
      pages.push(
        emptyPage(
          url,
          metadata.depth,
          metadata.source,
          sitemapUrls.has(url),
          'ROBOTS_BLOCKED',
          indexability,
        ),
      );
      continue;
    }
    const wait = options.crawlDelayMs - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    requested++;
    lastRequest = Date.now();
    try {
      const response = await controlledFetch(url, common);
      const isHtml = /^text\/html\b|^application\/xhtml\+xml\b/i.test(response.contentType);
      const page =
        response.body && isHtml
          ? extractHtml({
              html: response.body,
              requestedUrl: url,
              finalUrl: response.url,
              statusCode: response.status,
              redirectCount: response.redirects,
              contentType: response.contentType,
              responseBytes: response.bytes,
              responseTimeMs: response.durationMs,
              xRobotsTag: response.xRobotsTag,
              depth: metadata.depth,
              source: metadata.source,
              inSitemap: sitemapUrls.has(url),
            })
          : responsePage(url, metadata.depth, metadata.source, sitemapUrls.has(url), response);
      pages.push(page);
      for (const link of page.internalLinks) enqueue(link, metadata.depth + 1, 'LINK');
    } catch (error) {
      pages.push(
        emptyPage(
          url,
          metadata.depth,
          metadata.source,
          sitemapUrls.has(url),
          String(
            (error as { code?: string; name?: string }).code ??
              (error as Error).name ??
              'FETCH_FAILED',
          ),
        ),
      );
    }
    if (requested % 10 === 0)
      await options.onProgress?.({ requested, discovered: seen.size + queued.size });
  }
  return {
    pages,
    sitemapUrls,
    robots,
    cancelled,
    discovered: seen.size + queued.size,
    requested,
    durationMs: Math.round(performance.now() - started),
  };
}

function emptyPage(
  url: string,
  depth: number,
  source: DiscoverySource,
  inSitemap: boolean,
  error: string,
  indexability = classifyIndexability(null, null, null),
): ExtractedPage {
  return {
    url,
    finalUrl: url,
    statusCode: null,
    redirectCount: 0,
    contentType: null,
    responseBytes: 0,
    responseTimeMs: 0,
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
    indexable: indexability.indexable,
    indexabilityReasons: indexability.reasons,
    wordCount: 0,
    internalLinks: [],
    externalLinksCount: 0,
    nofollowInternalCount: 0,
    contentHash: null,
    crawlDepth: depth,
    discoverySource: source,
    inSitemap,
    language: null,
    viewportPresent: false,
    fetchedAt: new Date(),
    fetchErrorCode: error,
    bodyTooLarge: false,
  };
}

function responsePage(
  url: string,
  depth: number,
  source: DiscoverySource,
  inSitemap: boolean,
  response: Awaited<ReturnType<typeof controlledFetch>>,
): ExtractedPage {
  const indexability = classifyIndexability(response.status, null, response.xRobotsTag);
  return {
    ...emptyPage(
      url,
      depth,
      source,
      inSitemap,
      response.tooLarge ? 'BODY_TOO_LARGE' : (null as unknown as string),
      indexability,
    ),
    finalUrl: response.url,
    statusCode: response.status,
    redirectCount: response.redirects,
    contentType: response.contentType,
    responseBytes: response.bytes,
    responseTimeMs: response.durationMs,
    xRobotsTag: response.xRobotsTag,
    fetchedAt: new Date(),
    bodyTooLarge: response.tooLarge,
    fetchErrorCode: response.tooLarge ? 'BODY_TOO_LARGE' : null,
  };
}
