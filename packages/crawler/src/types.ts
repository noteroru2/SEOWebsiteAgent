export type DiscoverySource = 'BASE' | 'SITEMAP' | 'LINK';
export type IndexabilityReason =
  'INDEXABLE' | 'NOINDEX_META' | 'NOINDEX_HEADER' | 'NON_200' | 'ROBOTS_BLOCKED';

export interface ExtractedPage {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  redirectCount: number;
  contentType: string | null;
  responseBytes: number;
  responseTimeMs: number;
  title: string | null;
  titlePresent: boolean;
  titleLength: number | null;
  metaDescription: string | null;
  descriptionPresent: boolean;
  descriptionLength: number | null;
  h1Count: number;
  primaryH1: string | null;
  h2Count: number;
  canonicalUrl: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  indexable: boolean;
  indexabilityReasons: IndexabilityReason[];
  wordCount: number;
  internalLinks: string[];
  externalLinksCount: number;
  nofollowInternalCount: number;
  contentHash: string | null;
  crawlDepth: number;
  discoverySource: DiscoverySource;
  inSitemap: boolean;
  language: string | null;
  viewportPresent: boolean;
  fetchedAt: Date;
  fetchErrorCode: string | null;
  bodyTooLarge: boolean;
}

export interface RobotsResult {
  status: number | null;
  fetched: boolean;
  conservativeBlock: boolean;
  sitemaps: string[];
  rules: Array<{ allow: boolean; path: string }>;
  fetchDurationMs: number;
}

export interface CrawlResult {
  pages: ExtractedPage[];
  sitemapUrls: Set<string>;
  robots: RobotsResult;
  cancelled: boolean;
  discovered: number;
  requested: number;
  durationMs: number;
}

export interface CrawlOptions {
  baseUrl: string;
  maxPages: number;
  crawlDelayMs: number;
  requestTimeoutMs: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxRetries?: number;
  maxQueueSize?: number;
  allowPrivateNetworkForTests?: boolean;
  shouldCancel?: () => Promise<boolean>;
  onProgress?: (progress: { requested: number; discovered: number }) => Promise<void>;
}
