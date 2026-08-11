import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { safeDiscoveredUrl, isSameSite } from './url';
import type { ExtractedPage, IndexabilityReason } from './types';

export function classifyIndexability(
  statusCode: number | null,
  meta: string | null,
  header: string | null,
  robotsBlocked = false,
) {
  const reasons: IndexabilityReason[] = [];
  if (robotsBlocked) reasons.push('ROBOTS_BLOCKED');
  if (statusCode !== 200) reasons.push('NON_200');
  if (/\bnoindex\b/i.test(meta ?? '')) reasons.push('NOINDEX_META');
  if (/\bnoindex\b/i.test(header ?? '')) reasons.push('NOINDEX_HEADER');
  return {
    indexable: reasons.length === 0,
    reasons: reasons.length ? reasons : (['INDEXABLE'] as IndexabilityReason[]),
  };
}

export function extractHtml(input: {
  html: string;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  redirectCount: number;
  contentType: string;
  responseBytes: number;
  responseTimeMs: number;
  xRobotsTag: string | null;
  depth: number;
  source: ExtractedPage['discoverySource'];
  inSitemap: boolean;
  fetchedAt?: Date;
}): ExtractedPage {
  const $ = cheerio.load(input.html);
  $('script,style,noscript,template,svg').remove();
  const titleNodes = $('title');
  const title = titleNodes.first().text().trim();
  const descriptionNode = $('meta[name="description" i]').first();
  const description = descriptionNode.attr('content')?.trim() ?? '';
  const h1s = $('h1');
  const canonicalNodes = $('link[rel~="canonical" i]');
  const canonicalRaw = canonicalNodes.first().attr('href');
  const canonicalUrl = canonicalRaw ? safeDiscoveredUrl(canonicalRaw, input.finalUrl) : null;
  const robotsMeta = $('meta[name="robots" i]').attr('content')?.trim() ?? null;
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const internal = new Set<string>();
  let externalLinksCount = 0;
  let nofollowInternalCount = 0;
  $('a[href]').each((_, node) => {
    const url = safeDiscoveredUrl($(node).attr('href') ?? '', input.finalUrl);
    if (!url) return;
    if (isSameSite(url, input.finalUrl)) {
      internal.add(url);
      if (/\bnofollow\b/i.test($(node).attr('rel') ?? '')) nofollowInternalCount++;
    } else externalLinksCount++;
  });
  const indexability = classifyIndexability(input.statusCode, robotsMeta, input.xRobotsTag);
  return {
    url: input.requestedUrl,
    finalUrl: input.finalUrl,
    statusCode: input.statusCode,
    redirectCount: input.redirectCount,
    contentType: input.contentType,
    responseBytes: input.responseBytes,
    responseTimeMs: input.responseTimeMs,
    title: titleNodes.length ? title : null,
    titlePresent: titleNodes.length > 0,
    titleLength: titleNodes.length ? title.length : null,
    metaDescription: descriptionNode.length ? description : null,
    descriptionPresent: descriptionNode.length > 0,
    descriptionLength: descriptionNode.length ? description.length : null,
    h1Count: h1s.length,
    primaryH1: h1s.first().text().trim() || null,
    h2Count: $('h2').length,
    canonicalUrl,
    canonicalCount: canonicalNodes.length,
    robotsMeta,
    xRobotsTag: input.xRobotsTag,
    indexable: indexability.indexable,
    indexabilityReasons: indexability.reasons,
    wordCount: text ? text.split(/\s+/).length : 0,
    internalLinks: [...internal],
    externalLinksCount,
    nofollowInternalCount,
    contentHash: text ? createHash('sha256').update(text.toLowerCase()).digest('hex') : null,
    crawlDepth: input.depth,
    discoverySource: input.source,
    inSitemap: input.inSitemap,
    language: $('html').attr('lang')?.trim() || null,
    viewportPresent: $('meta[name="viewport" i]').length > 0,
    fetchedAt: input.fetchedAt ?? new Date(),
    fetchErrorCode: null,
    bodyTooLarge: false,
  };
}
