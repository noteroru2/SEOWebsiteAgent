export interface CrawlRequest {
  siteId: string;
  startUrl: URL;
  maxPages: number;
}
export interface Crawler {
  crawl(request: CrawlRequest): Promise<{ pages: number }>;
}
