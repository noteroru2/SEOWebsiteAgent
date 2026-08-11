import type { GscMetricRow, SearchAnalyticsRequest, SearchConsoleApi } from '@seo-agent/gsc';

export class FakeSearchConsoleApi implements SearchConsoleApi {
  calls: SearchAnalyticsRequest[] = [];
  constructor(
    readonly detailedRows = 10_000,
    readonly populatedDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
    readonly failure?: 'PERMISSION' | 'QUOTA' | 'SERVER',
  ) {}
  async listProperties() {
    return [
      { propertyUri: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { propertyUri: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
    ];
  }
  async query(request: SearchAnalyticsRequest) {
    this.calls.push(request);
    if (this.failure)
      throw Object.assign(new Error('Fake Google failure'), {
        code:
          this.failure === 'PERMISSION'
            ? 'PROPERTY_ACCESS_LOST'
            : this.failure === 'QUOTA'
              ? 'QUOTA_EXCEEDED'
              : 'GOOGLE_API_ERROR',
      });
    const queryPage = request.dimensions.includes('query') && request.dimensions.includes('page');
    const total =
      queryPage && request.startDate === this.populatedDate
        ? this.detailedRows
        : request.startRow === 0
          ? 1
          : 0;
    const count = Math.max(0, Math.min(request.rowLimit, total - request.startRow));
    const rows: GscMetricRow[] = Array.from({ length: count }, (_, offset) => {
      const index = request.startRow + offset;
      return {
        date: request.startDate,
        query: request.dimensions.includes('query') ? `query-${index}` : undefined,
        page: request.dimensions.includes('page') ? `https://example.com/page-${index}` : undefined,
        clicks: index % 5,
        impressions: 10 + (index % 7),
        ctr: (index % 5) / (10 + (index % 7)),
        position: 1 + (index % 20),
      };
    });
    return { rows };
  }
}
