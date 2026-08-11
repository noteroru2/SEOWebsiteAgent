import { createHash } from 'node:crypto';

export const OPPORTUNITY_ENGINE_VERSION = 'opportunity-engine-v1';

export const OPPORTUNITY_TYPES = [
  'STRIKING_DISTANCE_QUERY',
  'LOW_CTR_QUERY',
  'DECLINING_PAGE',
  'DECLINING_QUERY',
  'QUERY_PAGE_OVERLAP_CANDIDATE',
  'TECHNICAL_BLOCKER_WITH_DEMAND',
  'ORPHAN_WITH_SEARCH_DEMAND',
  'INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND',
  'UNMAPPED_GSC_PAGE',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];
export type OpportunityPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type OpportunityConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type OpportunityEntity = 'PAGE' | 'QUERY' | 'QUERY_PAGE' | 'SITE';

export type Metrics = {
  clicks: number;
  impressions: number;
  position: number;
};

export type QuerySignal = {
  query: string;
  page?: string;
  current: Metrics;
  previous?: Metrics;
  mappingReason?: string;
  crawlStatus?: number | null;
  indexable?: boolean;
  issueCodes?: string[];
};

export type PageSignal = {
  page: string;
  current: Metrics;
  previous?: Metrics;
  mappingReason?: string;
  crawlStatus?: number | null;
  indexable?: boolean;
  issueCodes?: string[];
  inSitemap?: boolean;
};

export type OverlapSignal = {
  query: string;
  totalClicks: number;
  totalImpressions: number;
  pages: Array<{ page: string; clicks: number; impressions: number; position: number }>;
};

export type UnmappedSignal = {
  page: string;
  current: Metrics;
  classification?: 'REDIRECT_VARIANT' | 'GSC_HISTORICAL_URL' | 'OTHER';
  crawlStatus?: number | null;
};

export type OpportunityInput = {
  siteId: string;
  queries: QuerySignal[];
  pages: PageSignal[];
  overlaps: OverlapSignal[];
  unmapped: UnmappedSignal[];
};

export type ScoreComponents = {
  demand: number;
  potential: number;
  evidenceStrength: number;
  mappingConfidence: number;
  total: number;
};

export type GeneratedOpportunity = {
  type: OpportunityType;
  entityType: OpportunityEntity;
  url?: string;
  query?: string;
  title: string;
  summary: string;
  unknown: string;
  priority: OpportunityPriority;
  confidence: OpportunityConfidence;
  score: number;
  scoreComponents: ScoreComponents;
  evidence: Record<string, unknown>;
  fingerprint: string;
  engineVersion: typeof OPPORTUNITY_ENGINE_VERSION;
};

export const OPPORTUNITY_CONFIG = {
  minimum: {
    queryImpressions: 20,
    lowCtrImpressions: 30,
    pageImpressions: 25,
    overlapImpressions: 40,
    unmappedImpressions: 20,
    previousImpressions: 30,
  },
  strikingPosition: { min: 4, max: 15 },
  ctr: {
    minimumBucketImpressions: 200,
    minimumBucketQueries: 5,
    minimumAbsoluteDeficit: 0.02,
    maximumBaselineRatio: 0.6,
  },
  decline: {
    positionLoss: 2,
    clickDropRatio: 0.4,
    clickDropAbsolute: 5,
    impressionDropRatio: 0.4,
    impressionDropAbsolute: 30,
    comparableImpressionRatio: 0.7,
  },
  overlap: {
    minimumPageImpressions: 10,
    minimumSecondaryShare: 0.2,
    maximumPrimaryShare: 0.8,
  },
  priority: { high: 75, medium: 50 },
  minimumScore: 42,
  resolutionMissingRuns: 2,
  caps: {
    total: 30,
    perPageQueries: 2,
    perType: {
      STRIKING_DISTANCE_QUERY: 10,
      LOW_CTR_QUERY: 6,
      DECLINING_PAGE: 5,
      DECLINING_QUERY: 5,
      QUERY_PAGE_OVERLAP_CANDIDATE: 5,
      TECHNICAL_BLOCKER_WITH_DEMAND: 5,
      ORPHAN_WITH_SEARCH_DEMAND: 4,
      INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND: 4,
      UNMAPPED_GSC_PAGE: 3,
    },
  },
} as const;

export const POSITION_BUCKETS = ['1', '2-3', '4-6', '7-10', '11-15', '16-20', '21+'] as const;
export type PositionBucket = (typeof POSITION_BUCKETS)[number];

const BLOCKING_CODES = new Set([
  'HTTP_4XX',
  'HTTP_5XX',
  'NOINDEX_PAGE',
  'X_ROBOTS_NOINDEX',
  'ROBOTS_BLOCKED',
  'CANONICAL_NON_200',
]);

export function positionBucket(position: number): PositionBucket {
  if (position < 1.5) return '1';
  if (position < 3.5) return '2-3';
  if (position < 6.5) return '4-6';
  if (position < 10.5) return '7-10';
  if (position < 15.5) return '11-15';
  if (position < 20.5) return '16-20';
  return '21+';
}

export function aggregateMetrics(rows: Metrics[]): Metrics {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weighted = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);
  return { clicks, impressions, position: impressions ? weighted / impressions : 0 };
}

export function ctr(metrics: Metrics) {
  return metrics.impressions ? metrics.clicks / metrics.impressions : 0;
}

export function buildCtrBaselines(queries: QuerySignal[]) {
  const buckets = new Map<
    PositionBucket,
    { clicks: number; impressions: number; queries: number }
  >();
  for (const signal of queries) {
    if (!signal.current.impressions) continue;
    const key = positionBucket(signal.current.position);
    const value = buckets.get(key) ?? { clicks: 0, impressions: 0, queries: 0 };
    value.clicks += signal.current.clicks;
    value.impressions += signal.current.impressions;
    value.queries++;
    buckets.set(key, value);
  }
  return new Map(
    [...buckets.entries()]
      .filter(
        ([, value]) =>
          value.impressions >= OPPORTUNITY_CONFIG.ctr.minimumBucketImpressions &&
          value.queries >= OPPORTUNITY_CONFIG.ctr.minimumBucketQueries,
      )
      .map(([key, value]) => [
        key,
        { ...value, ctr: value.impressions ? value.clicks / value.impressions : 0 },
      ]),
  );
}

export function stableFingerprint(parts: Array<string | undefined>) {
  return createHash('sha256')
    .update(parts.map((value) => value?.trim().toLowerCase() ?? '').join('\u001f'))
    .digest('hex');
}

export function priorityForScore(score: number): OpportunityPriority {
  if (score >= OPPORTUNITY_CONFIG.priority.high) return 'HIGH';
  if (score >= OPPORTUNITY_CONFIG.priority.medium) return 'MEDIUM';
  return 'LOW';
}

function demandScore(metrics: Metrics) {
  if (!metrics.impressions) return 0;
  return Math.min(
    40,
    Math.round(Math.log10(metrics.impressions + 1) * 11 + Math.min(metrics.clicks, 12)),
  );
}

function evidenceScore(metrics: Metrics, hasPrevious = false) {
  const sample =
    metrics.impressions >= 200
      ? 18
      : metrics.impressions >= 100
        ? 16
        : metrics.impressions >= 50
          ? 14
          : metrics.impressions >= 20
            ? 11
            : 7;
  return Math.min(20, sample + (hasPrevious ? 2 : 0));
}

function mappingScore(reason?: string, deterministicTechnical = false) {
  if (reason === 'EXACT_URL') return 15;
  if (reason === 'FINAL_URL') return 13;
  if (reason === 'CANONICAL_MATCH') return 11;
  return deterministicTechnical ? 9 : 5;
}

export function scoreComponents(
  metrics: Metrics,
  potential: number,
  mappingReason?: string,
  options: { hasPrevious?: boolean; deterministicTechnical?: boolean } = {},
): ScoreComponents {
  const result = {
    demand: demandScore(metrics),
    potential: Math.max(0, Math.min(25, Math.round(potential))),
    evidenceStrength: evidenceScore(metrics, options.hasPrevious),
    mappingConfidence: mappingScore(mappingReason, options.deterministicTechnical),
    total: 0,
  };
  result.total = Math.min(
    100,
    result.demand + result.potential + result.evidenceStrength + result.mappingConfidence,
  );
  return result;
}

function confidenceFor(
  metrics: Metrics,
  mappingReason?: string,
  options: { hasPrevious?: boolean; deterministicTechnical?: boolean } = {},
): OpportunityConfidence {
  if (!mappingReason && !options.deterministicTechnical) return 'LOW';
  if (
    metrics.impressions >= 100 &&
    (mappingReason === 'EXACT_URL' || options.deterministicTechnical) &&
    (!options.hasPrevious || options.hasPrevious)
  )
    return 'HIGH';
  if (metrics.impressions >= 30) return 'MEDIUM';
  return 'LOW';
}

function blockingCode(signal: {
  crawlStatus?: number | null;
  indexable?: boolean;
  issueCodes?: string[];
}) {
  if ((signal.crawlStatus ?? 0) >= 500) return 'HTTP_5XX';
  if ((signal.crawlStatus ?? 0) >= 400) return 'HTTP_4XX';
  return signal.issueCodes?.find((code) => BLOCKING_CODES.has(code));
}

type Draft = Omit<GeneratedOpportunity, 'fingerprint' | 'engineVersion'> & {
  identityExtra?: string;
};

function finish(siteId: string, draft: Draft): GeneratedOpportunity {
  return {
    ...draft,
    fingerprint: stableFingerprint([
      siteId,
      draft.type,
      draft.query,
      draft.url,
      draft.identityExtra,
    ]),
    engineVersion: OPPORTUNITY_ENGINE_VERSION,
  };
}

function draft(
  type: OpportunityType,
  entityType: OpportunityEntity,
  metrics: Metrics,
  potential: number,
  fields: {
    url?: string;
    query?: string;
    mappingReason?: string;
    hasPrevious?: boolean;
    deterministicTechnical?: boolean;
    title: string;
    summary: string;
    unknown: string;
    evidence: Record<string, unknown>;
    identityExtra?: string;
  },
): Draft {
  const components = scoreComponents(metrics, potential, fields.mappingReason, fields);
  return {
    type,
    entityType,
    url: fields.url,
    query: fields.query,
    title: fields.title,
    summary: fields.summary,
    unknown: fields.unknown,
    priority: priorityForScore(components.total),
    confidence: confidenceFor(metrics, fields.mappingReason, fields),
    score: components.total,
    scoreComponents: components,
    evidence: fields.evidence,
    identityExtra: fields.identityExtra,
  };
}

function declineEvidence(current: Metrics, previous: Metrics) {
  const clicksDrop = previous.clicks ? (previous.clicks - current.clicks) / previous.clicks : 0;
  const impressionsDrop = previous.impressions
    ? (previous.impressions - current.impressions) / previous.impressions
    : 0;
  const positionLoss = current.position - previous.position;
  const meaningful =
    (current.impressions >= OPPORTUNITY_CONFIG.minimum.pageImpressions &&
      positionLoss >= OPPORTUNITY_CONFIG.decline.positionLoss) ||
    (previous.clicks - current.clicks >= OPPORTUNITY_CONFIG.decline.clickDropAbsolute &&
      clicksDrop >= OPPORTUNITY_CONFIG.decline.clickDropRatio &&
      current.impressions >=
        previous.impressions * OPPORTUNITY_CONFIG.decline.comparableImpressionRatio) ||
    (previous.impressions - current.impressions >=
      OPPORTUNITY_CONFIG.decline.impressionDropAbsolute &&
      impressionsDrop >= OPPORTUNITY_CONFIG.decline.impressionDropRatio);
  return { meaningful, clicksDrop, impressionsDrop, positionLoss };
}

export function generateOpportunitySet(input: OpportunityInput) {
  const candidates: GeneratedOpportunity[] = [];
  const suppressionCounts: Record<string, number> = {};
  let candidatesGenerated = 0;
  const suppress = (reason: string) => {
    suppressionCounts[reason] = (suppressionCounts[reason] ?? 0) + 1;
  };
  const consider = (value: Draft | undefined, failureReason?: string) => {
    candidatesGenerated++;
    if (!value) return suppress(failureReason ?? 'INSUFFICIENT_EVIDENCE');
    if (value.score < OPPORTUNITY_CONFIG.minimumScore) return suppress('INSUFFICIENT_EVIDENCE');
    candidates.push(finish(input.siteId, value));
  };
  const baselines = buildCtrBaselines(input.queries);

  for (const signal of input.queries) {
    const blocker = blockingCode(signal);
    if (
      signal.current.position >= OPPORTUNITY_CONFIG.strikingPosition.min &&
      signal.current.position <= OPPORTUNITY_CONFIG.strikingPosition.max
    ) {
      consider(
        signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.queryImpressions &&
          signal.page &&
          signal.mappingReason &&
          signal.indexable === true &&
          !blocker
          ? draft(
              'STRIKING_DISTANCE_QUERY',
              'QUERY_PAGE',
              signal.current,
              8 + (15 - signal.current.position),
              {
                url: signal.page,
                query: signal.query,
                mappingReason: signal.mappingReason,
                title: 'Query within striking distance',
                summary:
                  'This query is already within striking distance and has meaningful search demand.',
                unknown:
                  'The engine cannot predict ranking gains or determine which change, if any, would improve performance.',
                evidence: {
                  query: signal.query,
                  page: signal.page,
                  currentClicks: signal.current.clicks,
                  currentImpressions: signal.current.impressions,
                  currentCtr: ctr(signal.current),
                  currentPosition: signal.current.position,
                  mappingReason: signal.mappingReason,
                  crawlStatus: signal.crawlStatus,
                  indexable: signal.indexable,
                },
              },
            )
          : undefined,
      );
    }

    if (signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.lowCtrImpressions) {
      const bucket = positionBucket(signal.current.position);
      const baseline = baselines.get(bucket);
      if (!baseline) {
        consider(undefined, 'NO_RELIABLE_CTR_BASELINE');
      } else {
        const observed = ctr(signal.current);
        const deficit = baseline.ctr - observed;
        const ratio = baseline.ctr ? observed / baseline.ctr : 1;
        consider(
          signal.page &&
            signal.mappingReason &&
            signal.indexable === true &&
            !blocker &&
            deficit >= OPPORTUNITY_CONFIG.ctr.minimumAbsoluteDeficit &&
            ratio <= OPPORTUNITY_CONFIG.ctr.maximumBaselineRatio
            ? draft('LOW_CTR_QUERY', 'QUERY_PAGE', signal.current, Math.min(25, deficit * 300), {
                url: signal.page,
                query: signal.query,
                mappingReason: signal.mappingReason,
                title: 'CTR below comparable-position baseline',
                summary: "CTR is below the site's observed baseline at a similar position.",
                unknown:
                  'The engine cannot determine whether intent, snippet wording, brand effects, SERP features, or competitors caused the difference.',
                evidence: {
                  query: signal.query,
                  page: signal.page,
                  currentClicks: signal.current.clicks,
                  currentImpressions: signal.current.impressions,
                  currentCtr: observed,
                  currentPosition: signal.current.position,
                  positionBucket: bucket,
                  bucketCtrBaseline: baseline.ctr,
                  bucketImpressions: baseline.impressions,
                  bucketQueries: baseline.queries,
                  mappingReason: signal.mappingReason,
                  crawlStatus: signal.crawlStatus,
                  indexable: signal.indexable,
                },
              })
            : undefined,
        );
      }
    }

    if (signal.previous) {
      const decline = declineEvidence(signal.current, signal.previous);
      consider(
        signal.previous.impressions >= OPPORTUNITY_CONFIG.minimum.previousImpressions &&
          signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.queryImpressions &&
          decline.meaningful
          ? draft(
              'DECLINING_QUERY',
              'QUERY',
              signal.current,
              Math.min(
                25,
                8 +
                  decline.positionLoss * 4 +
                  decline.clicksDrop * 12 +
                  decline.impressionsDrop * 10,
              ),
              {
                url: signal.page,
                query: signal.query,
                mappingReason: signal.mappingReason,
                hasPrevious: true,
                title: 'Query performance decline candidate',
                summary:
                  'This query shows a meaningful performance decline compared with the previous period.',
                unknown:
                  'The engine cannot determine causation or whether the change is temporary, seasonal, or SERP-driven.',
                evidence: {
                  query: signal.query,
                  page: signal.page,
                  current: signal.current,
                  previous: signal.previous,
                  ...decline,
                },
              },
            )
          : undefined,
        signal.previous.impressions < OPPORTUNITY_CONFIG.minimum.previousImpressions
          ? 'INSUFFICIENT_EVIDENCE'
          : undefined,
      );
    }
  }

  for (const signal of input.pages) {
    const blocker = blockingCode(signal);
    if (signal.previous) {
      const decline = declineEvidence(signal.current, signal.previous);
      consider(
        signal.previous.impressions >= OPPORTUNITY_CONFIG.minimum.previousImpressions &&
          decline.meaningful
          ? draft(
              'DECLINING_PAGE',
              'PAGE',
              signal.current,
              Math.min(
                25,
                10 +
                  decline.positionLoss * 4 +
                  decline.clicksDrop * 12 +
                  decline.impressionsDrop * 10,
              ),
              {
                url: signal.page,
                mappingReason: signal.mappingReason,
                hasPrevious: true,
                title: 'Page performance decline candidate',
                summary:
                  'This page shows a meaningful performance decline compared with the previous period.',
                unknown:
                  'The engine cannot determine causation or whether the change is temporary, seasonal, or SERP-driven.',
                evidence: {
                  page: signal.page,
                  current: signal.current,
                  previous: signal.previous,
                  ...decline,
                },
              },
            )
          : undefined,
      );
    }
    if (blocker && signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.pageImpressions) {
      consider(
        draft('TECHNICAL_BLOCKER_WITH_DEMAND', 'PAGE', signal.current, 25, {
          url: signal.page,
          mappingReason: signal.mappingReason,
          deterministicTechnical: true,
          identityExtra: blocker,
          title: 'Technical blocker on a page with search demand',
          summary:
            'A deterministic crawl blocker is present on a URL that still receives Search Console demand.',
          unknown:
            'The engine cannot determine the correct remediation or whether the current technical state is intentional.',
          evidence: {
            page: signal.page,
            currentClicks: signal.current.clicks,
            currentImpressions: signal.current.impressions,
            currentPosition: signal.current.position,
            crawlStatus: signal.crawlStatus,
            indexable: signal.indexable,
            blockingIssue: blocker,
            issueCodes: signal.issueCodes ?? [],
            mappingReason: signal.mappingReason,
          },
        }),
      );
    }
    if (
      signal.issueCodes?.includes('ORPHAN_CANDIDATE') &&
      signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.pageImpressions
    ) {
      consider(
        draft('ORPHAN_WITH_SEARCH_DEMAND', 'PAGE', signal.current, 16, {
          url: signal.page,
          mappingReason: signal.mappingReason,
          title: 'Internal-link opportunity candidate with demand',
          summary:
            'This indexable sitemap page received no internal links in the bounded crawl and has real search demand.',
          unknown:
            'A bounded crawl cannot prove perfect orphan status or prescribe the best internal-link source.',
          evidence: {
            page: signal.page,
            current: signal.current,
            inSitemap: signal.inSitemap,
            issueCode: 'ORPHAN_CANDIDATE',
          },
        }),
      );
    }
    if (
      signal.issueCodes?.includes('INDEXABLE_URL_NOT_IN_SITEMAP') &&
      signal.current.impressions >= OPPORTUNITY_CONFIG.minimum.pageImpressions
    ) {
      consider(
        draft('INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND', 'PAGE', signal.current, 11, {
          url: signal.page,
          mappingReason: signal.mappingReason,
          title: 'Indexable page with demand is absent from sitemap',
          summary:
            'This indexable URL has search demand but was not found in the bounded sitemap set.',
          unknown:
            'Sitemap inclusion is not required for ranking, and the engine cannot determine whether omission is intentional.',
          evidence: {
            page: signal.page,
            current: signal.current,
            inSitemap: signal.inSitemap,
            issueCode: 'INDEXABLE_URL_NOT_IN_SITEMAP',
          },
        }),
      );
    }
  }

  for (const signal of input.overlaps) {
    candidatesGenerated++;
    const significant = signal.pages
      .filter((page) => page.impressions >= OPPORTUNITY_CONFIG.overlap.minimumPageImpressions)
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
    const primaryShare = significant[0]?.impressions
      ? significant[0].impressions / signal.totalImpressions
      : 0;
    const secondaryShare = significant[1]?.impressions
      ? significant[1].impressions / signal.totalImpressions
      : 0;
    if (
      signal.totalImpressions < OPPORTUNITY_CONFIG.minimum.overlapImpressions ||
      significant.length < 2 ||
      primaryShare > OPPORTUNITY_CONFIG.overlap.maximumPrimaryShare ||
      secondaryShare < OPPORTUNITY_CONFIG.overlap.minimumSecondaryShare
    ) {
      suppress('WEAK_QUERY_PAGE_SHARE');
      continue;
    }
    const metrics = {
      clicks: signal.totalClicks,
      impressions: signal.totalImpressions,
      position:
        significant.reduce((sum, p) => sum + p.position * p.impressions, 0) /
        signal.totalImpressions,
    };
    const value = draft(
      'QUERY_PAGE_OVERLAP_CANDIDATE',
      'QUERY',
      metrics,
      16 + secondaryShare * 20,
      {
        query: signal.query,
        title: 'Query-page overlap candidate',
        summary:
          'Multiple pages receive meaningful impressions for the same query, indicating an ownership overlap worth reviewing.',
        unknown:
          'The engine cannot determine intent, preferred ownership, or whether multiple results are beneficial.',
        evidence: {
          query: signal.query,
          totalClicks: signal.totalClicks,
          totalImpressions: signal.totalImpressions,
          significantPages: significant,
          primaryShare,
          secondaryShare,
        },
      },
    );
    candidates.push(finish(input.siteId, value));
  }

  for (const signal of input.unmapped) {
    candidatesGenerated++;
    if (signal.current.impressions < OPPORTUNITY_CONFIG.minimum.unmappedImpressions) {
      suppress('INSUFFICIENT_EVIDENCE');
      continue;
    }
    const value = draft(
      'UNMAPPED_GSC_PAGE',
      'PAGE',
      signal.current,
      signal.crawlStatus === 404 ? 18 : 9,
      {
        url: signal.page,
        deterministicTechnical: signal.crawlStatus === 404,
        title: 'Search Console page is not mapped to the latest crawl',
        summary:
          'This Search Console URL has meaningful demand but no deterministic crawl-page mapping.',
        unknown:
          'The engine cannot infer URL equivalence; the URL may be historical, redirected, intentionally separate, or absent from the bounded crawl.',
        evidence: {
          page: signal.page,
          current: signal.current,
          classification: signal.classification ?? 'OTHER',
          crawlStatus: signal.crawlStatus ?? null,
        },
      },
    );
    candidates.push(finish(input.siteId, value));
  }

  const unique = new Map<string, GeneratedOpportunity>();
  for (const candidate of candidates.sort(
    (a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint),
  )) {
    if (unique.has(candidate.fingerprint)) suppress('DUPLICATE');
    else unique.set(candidate.fingerprint, candidate);
  }
  const retained: GeneratedOpportunity[] = [];
  const typeCounts = new Map<OpportunityType, number>();
  const pageQueryCounts = new Map<string, number>();
  for (const candidate of unique.values()) {
    const typeCount = typeCounts.get(candidate.type) ?? 0;
    if (typeCount >= OPPORTUNITY_CONFIG.caps.perType[candidate.type]) {
      suppress('PER_TYPE_CAP');
      continue;
    }
    if (
      candidate.url &&
      ['STRIKING_DISTANCE_QUERY', 'LOW_CTR_QUERY', 'DECLINING_QUERY'].includes(candidate.type)
    ) {
      const pageCount = pageQueryCounts.get(candidate.url) ?? 0;
      if (pageCount >= OPPORTUNITY_CONFIG.caps.perPageQueries) {
        suppress('PER_PAGE_CAP');
        continue;
      }
      pageQueryCounts.set(candidate.url, pageCount + 1);
    }
    if (retained.length >= OPPORTUNITY_CONFIG.caps.total) {
      suppress('PER_TYPE_CAP');
      continue;
    }
    retained.push(candidate);
    typeCounts.set(candidate.type, typeCount + 1);
  }
  return {
    opportunities: retained,
    candidatesGenerated,
    opportunitiesSuppressed: Object.values(suppressionCounts).reduce(
      (sum, value) => sum + value,
      0,
    ),
    suppressionCounts,
    ctrBaselines: Object.fromEntries(baselines),
  };
}
