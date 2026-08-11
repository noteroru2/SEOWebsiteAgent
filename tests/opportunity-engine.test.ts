import { describe, expect, it } from 'vitest';
import {
  aggregateMetrics,
  buildCtrBaselines,
  generateOpportunitySet,
  OPPORTUNITY_CONFIG,
  positionBucket,
  priorityForScore,
  scoreComponents,
  stableFingerprint,
  type OpportunityInput,
  type QuerySignal,
} from '@seo-agent/opportunity-engine';

const siteId = '11111111-1111-4111-8111-111111111111';
const metrics = (impressions: number, clicks: number, position: number) => ({
  impressions,
  clicks,
  position,
});
const query = (overrides: Partial<QuerySignal> = {}): QuerySignal => ({
  query: 'useful query',
  page: 'https://example.com/page',
  current: metrics(120, 12, 8),
  mappingReason: 'EXACT_URL',
  crawlStatus: 200,
  indexable: true,
  issueCodes: [],
  ...overrides,
});
const input = (overrides: Partial<OpportunityInput> = {}): OpportunityInput => ({
  siteId,
  queries: [],
  pages: [],
  overlaps: [],
  unmapped: [],
  ...overrides,
});
const find = (value: ReturnType<typeof generateOpportunitySet>, type: string) =>
  value.opportunities.find((item) => item.type === type);

describe('deterministic opportunity engine', () => {
  it('uses impression-weighted position and aggregate CTR inputs', () => {
    expect(aggregateMetrics([metrics(100, 10, 2), metrics(300, 15, 10)])).toEqual({
      impressions: 400,
      clicks: 25,
      position: 8,
    });
  });

  it('assigns stable position buckets', () => {
    expect([1, 2, 5, 8, 13, 18, 30].map(positionBucket)).toEqual([
      '1',
      '2-3',
      '4-6',
      '7-10',
      '11-15',
      '16-20',
      '21+',
    ]);
  });

  it('builds CTR baselines from aggregate clicks/impressions only with adequate evidence', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      query({ query: `baseline-${index}`, current: metrics(50, 5, 5) }),
    );
    expect(buildCtrBaselines(rows).get('4-6')?.ctr).toBe(0.1);
    expect(buildCtrBaselines(rows.slice(0, 3)).has('4-6')).toBe(false);
  });

  it('creates a strong STRIKING_DISTANCE_QUERY', () => {
    const result = generateOpportunitySet(input({ queries: [query()] }));
    expect(find(result, 'STRIKING_DISTANCE_QUERY')).toMatchObject({
      query: 'useful query',
      url: 'https://example.com/page',
      confidence: 'HIGH',
    });
  });

  it('suppresses striking-distance queries with tiny impressions', () => {
    const result = generateOpportunitySet(
      input({ queries: [query({ current: metrics(3, 0, 8) })] }),
    );
    expect(find(result, 'STRIKING_DISTANCE_QUERY')).toBeUndefined();
    expect(result.suppressionCounts.INSUFFICIENT_EVIDENCE).toBeGreaterThan(0);
  });

  it('creates LOW_CTR_QUERY only when materially below a reliable bucket baseline', () => {
    const baselines = Array.from({ length: 5 }, (_, index) =>
      query({
        query: `baseline-${index}`,
        page: `https://example.com/b${index}`,
        current: metrics(50, 5, 5),
      }),
    );
    const target = query({ query: 'low ctr', current: metrics(100, 1, 5) });
    const result = generateOpportunitySet(input({ queries: [...baselines, target] }));
    expect(find(result, 'LOW_CTR_QUERY')?.evidence).toMatchObject({
      query: 'low ctr',
      positionBucket: '4-6',
    });
  });

  it('does not create LOW_CTR_QUERY near the bucket baseline', () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      query({
        query: `normal-${index}`,
        page: `https://example.com/n${index}`,
        current: metrics(50, 5, 5),
      }),
    );
    expect(find(generateOpportunitySet(input({ queries: rows })), 'LOW_CTR_QUERY')).toBeUndefined();
  });

  it('suppresses LOW_CTR_QUERY when the position bucket is unreliable', () => {
    const result = generateOpportunitySet(
      input({ queries: [query({ current: metrics(100, 0, 5) })] }),
    );
    expect(find(result, 'LOW_CTR_QUERY')).toBeUndefined();
    expect(result.suppressionCounts.NO_RELIABLE_CTR_BASELINE).toBe(1);
  });

  it('creates a meaningful DECLINING_PAGE and suppresses a tiny decline', () => {
    const meaningful = {
      page: 'https://example.com/decline',
      current: metrics(80, 4, 10),
      previous: metrics(120, 15, 6),
      mappingReason: 'EXACT_URL',
      crawlStatus: 200,
      indexable: true,
      issueCodes: [],
      inSitemap: true,
    };
    const tiny = {
      ...meaningful,
      page: 'https://example.com/tiny',
      current: metrics(5, 0, 9),
      previous: metrics(6, 1, 8),
    };
    const result = generateOpportunitySet(input({ pages: [meaningful, tiny] }));
    expect(find(result, 'DECLINING_PAGE')?.url).toBe(meaningful.page);
    expect(result.opportunities.some((item) => item.url === tiny.page)).toBe(false);
  });

  it('creates a meaningful DECLINING_QUERY and caps many declining queries on one page', () => {
    const queries = Array.from({ length: 8 }, (_, index) =>
      query({
        query: `decline-${index}`,
        current: metrics(80 + index, 2, 11),
        previous: metrics(120 + index, 15, 6),
      }),
    );
    const result = generateOpportunitySet(input({ queries }));
    expect(result.opportunities.filter((item) => item.type === 'DECLINING_QUERY')).toHaveLength(
      OPPORTUNITY_CONFIG.caps.perPageQueries,
    );
    expect(result.suppressionCounts.PER_PAGE_CAP).toBeGreaterThan(0);
  });

  it('suppresses declines without previous-period data', () => {
    expect(
      find(generateOpportunitySet(input({ queries: [query()] })), 'DECLINING_QUERY'),
    ).toBeUndefined();
  });

  it('creates balanced QUERY_PAGE_OVERLAP_CANDIDATE', () => {
    const result = generateOpportunitySet(
      input({
        overlaps: [
          {
            query: 'shared intent',
            totalClicks: 30,
            totalImpressions: 1000,
            pages: [
              { page: 'https://example.com/a', clicks: 16, impressions: 520, position: 5 },
              { page: 'https://example.com/b', clicks: 14, impressions: 420, position: 6 },
            ],
          },
        ],
      }),
    );
    expect(find(result, 'QUERY_PAGE_OVERLAP_CANDIDATE')).toBeTruthy();
  });

  it('suppresses a 99.5% dominant query-page distribution', () => {
    const result = generateOpportunitySet(
      input({
        overlaps: [
          {
            query: 'dominant',
            totalClicks: 20,
            totalImpressions: 1000,
            pages: [
              { page: 'https://example.com/a', clicks: 20, impressions: 995, position: 3 },
              { page: 'https://example.com/b', clicks: 0, impressions: 5, position: 20 },
            ],
          },
        ],
      }),
    );
    expect(find(result, 'QUERY_PAGE_OVERLAP_CANDIDATE')).toBeUndefined();
    expect(result.suppressionCounts.WEAK_QUERY_PAGE_SHARE).toBe(1);
  });

  it.each([
    ['HTTP_4XX', 404],
    ['NOINDEX_PAGE', 200],
  ])('creates TECHNICAL_BLOCKER_WITH_DEMAND for %s', (code, status) => {
    const result = generateOpportunitySet(
      input({
        pages: [
          {
            page: `https://example.com/${code}`,
            current: metrics(200, 8, 12),
            mappingReason: 'EXACT_URL',
            crawlStatus: status,
            indexable: false,
            issueCodes: [code],
            inSitemap: true,
          },
        ],
      }),
    );
    expect(find(result, 'TECHNICAL_BLOCKER_WITH_DEMAND')?.evidence).toMatchObject({
      blockingIssue: code,
    });
  });

  it('does not treat cosmetic title warnings as technical blockers', () => {
    const result = generateOpportunitySet(
      input({
        pages: [
          {
            page: 'https://example.com/cosmetic',
            current: metrics(200, 8, 12),
            mappingReason: 'EXACT_URL',
            crawlStatus: 200,
            indexable: true,
            issueCodes: ['TITLE_TOO_LONG'],
            inSitemap: true,
          },
        ],
      }),
    );
    expect(find(result, 'TECHNICAL_BLOCKER_WITH_DEMAND')).toBeUndefined();
  });

  it('creates ORPHAN_WITH_SEARCH_DEMAND only when demand exists', () => {
    const base = {
      page: 'https://example.com/orphan',
      mappingReason: 'EXACT_URL',
      crawlStatus: 200,
      indexable: true,
      issueCodes: ['ORPHAN_CANDIDATE'],
      inSitemap: true,
    };
    const strong = generateOpportunitySet(
      input({ pages: [{ ...base, current: metrics(100, 3, 12) }] }),
    );
    const weak = generateOpportunitySet(
      input({ pages: [{ ...base, current: metrics(2, 0, 12) }] }),
    );
    expect(find(strong, 'ORPHAN_WITH_SEARCH_DEMAND')).toBeTruthy();
    expect(find(weak, 'ORPHAN_WITH_SEARCH_DEMAND')).toBeUndefined();
  });

  it('creates INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND', () => {
    const result = generateOpportunitySet(
      input({
        pages: [
          {
            page: 'https://example.com/not-in-map',
            current: metrics(100, 3, 12),
            mappingReason: 'EXACT_URL',
            crawlStatus: 200,
            indexable: true,
            issueCodes: ['INDEXABLE_URL_NOT_IN_SITEMAP'],
            inSitemap: false,
          },
        ],
      }),
    );
    expect(find(result, 'INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND')).toBeTruthy();
  });

  it.each(['GSC_HISTORICAL_URL', 'REDIRECT_VARIANT'] as const)(
    'creates a cautious UNMAPPED_GSC_PAGE for %s with demand',
    (classification) => {
      const result = generateOpportunitySet(
        input({
          unmapped: [
            {
              page: `https://example.com/${classification}`,
              current: metrics(80, 2, 18),
              classification,
            },
          ],
        }),
      );
      expect(find(result, 'UNMAPPED_GSC_PAGE')?.confidence).toBe('LOW');
    },
  );

  it('suppresses unmapped pages with tiny demand, zero impressions, and weak evidence', () => {
    const result = generateOpportunitySet(
      input({
        unmapped: [
          { page: 'https://example.com/tiny', current: metrics(1, 0, 20) },
          { page: 'https://example.com/zero', current: metrics(0, 0, 0) },
        ],
      }),
    );
    expect(result.opportunities).toHaveLength(0);
  });

  it('supports zero clicks without division errors', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      query({
        query: `baseline-${index}`,
        page: `https://example.com/${index}`,
        current: metrics(50, 5, 5),
      }),
    );
    const result = generateOpportunitySet(
      input({ queries: [...rows, query({ query: 'zero clicks', current: metrics(100, 0, 5) })] }),
    );
    expect(find(result, 'LOW_CTR_QUERY')?.evidence.currentCtr).toBe(0);
  });

  it('assigns high confidence to exact mapping and low confidence to weak mapping', () => {
    const exact = find(
      generateOpportunitySet(input({ queries: [query()] })),
      'STRIKING_DISTANCE_QUERY',
    );
    const weak = find(
      generateOpportunitySet(
        input({ unmapped: [{ page: 'https://example.com/x', current: metrics(30, 0, 20) }] }),
      ),
      'UNMAPPED_GSC_PAGE',
    );
    expect(exact?.confidence).toBe('HIGH');
    expect(weak?.confidence).toBe('LOW');
  });

  it('keeps fingerprints stable when volatile metrics change and prevents duplicates', () => {
    const first = query();
    const second = query({ current: metrics(500, 40, 7) });
    const a = find(generateOpportunitySet(input({ queries: [first] })), 'STRIKING_DISTANCE_QUERY');
    const b = find(generateOpportunitySet(input({ queries: [second] })), 'STRIKING_DISTANCE_QUERY');
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(stableFingerprint([siteId, 'TYPE', 'query', 'url'])).toBe(
      stableFingerprint([siteId, 'TYPE', 'query', 'url']),
    );
  });

  it('reconstructs total score and maps centralized priority thresholds', () => {
    const value = scoreComponents(metrics(200, 10, 8), 20, 'EXACT_URL');
    expect(value.total).toBe(
      value.demand + value.potential + value.evidenceStrength + value.mappingConfidence,
    );
    expect(priorityForScore(75)).toBe('HIGH');
    expect(priorityForScore(50)).toBe('MEDIUM');
    expect(priorityForScore(49)).toBe('LOW');
  });

  it('enforces per-type and total caps deterministically', () => {
    const queries = Array.from({ length: 50 }, (_, index) =>
      query({
        query: `query-${String(index).padStart(2, '0')}`,
        page: `https://example.com/page-${index}`,
        current: metrics(200 - index, 10, 8),
      }),
    );
    const result = generateOpportunitySet(input({ queries }));
    expect(
      result.opportunities.filter((item) => item.type === 'STRIKING_DISTANCE_QUERY').length,
    ).toBeLessThanOrEqual(OPPORTUNITY_CONFIG.caps.perType.STRIKING_DISTANCE_QUERY);
    expect(result.opportunities.length).toBeLessThanOrEqual(OPPORTUNITY_CONFIG.caps.total);
  });
});
