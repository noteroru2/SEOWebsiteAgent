import {
  claimNextJob,
  markJobFailed,
  markJobSucceeded,
  recoverStaleJobs,
  registeredJobTypes,
  databaseForPool,
  getSite,
  createCrawlRun,
  persistCrawlResult,
  failCrawlRun,
  jobCancellationRequested,
  touchJobHeartbeat,
  markJobCancelled,
  recordJobEvent,
  type Database,
} from '@seo-agent/database';
import { resourceGuardFromEnv, type ResourceGuard } from '@seo-agent/resource-guard';
import { crawlSite } from '@seo-agent/crawler';
import { analyzePages, summarizeCrawl } from '@seo-agent/seo-engine';
import type { JobType } from '@seo-agent/shared';
import type { Pool } from 'pg';

export async function executeOne(
  workerId: string,
  pool: Pool,
  guard: ResourceGuard = resourceGuardFromEnv(),
) {
  const resource = await guard.evaluate();
  if (!resource.allowed) return { state: 'RESOURCE_DENIED' as const, resource };
  const job = await claimNextJob(workerId, pool);
  if (!job) return { state: 'IDLE' as const };
  const id = String(job.id);
  const database = databaseForPool(pool);
  try {
    const type = String(job.type);
    if (!registeredJobTypes.has(type as JobType))
      throw Object.assign(new Error('Unregistered job type'), { code: 'UNREGISTERED_JOB_TYPE' });
    if (type === 'SYSTEM_TEST') {
      const completed = await markJobSucceeded(
        id,
        {
          ok: true,
          message: 'Web → PostgreSQL → Worker → PostgreSQL flow completed',
          completedAt: new Date().toISOString(),
        },
        pool,
      );
      return { state: 'SUCCEEDED' as const, job: completed };
    }
    if (type === 'SITE_CRAWL') {
      const siteId = String(job.site_id ?? '');
      const site = await getSite(siteId, database);
      if (!site || !site.active || !site.crawlEnabled)
        throw Object.assign(new Error('Site is unavailable or crawling is disabled'), {
          code: 'SITE_CRAWL_DISABLED',
        });
      const run = await createCrawlRun(site.id, id, database);
      await recordJobEvent(id, 'CRAWL_STARTED', { crawlRunId: run.id, siteId }, database);
      let lastHeartbeat = 0;
      try {
        const crawl = await crawlSite({
          baseUrl: site.url,
          maxPages: site.maxPages,
          crawlDelayMs: site.crawlDelayMs,
          requestTimeoutMs: site.requestTimeoutMs,
          maxBodyBytes: Number(process.env.CRAWLER_MAX_BODY_BYTES ?? 5 * 1024 * 1024),
          maxRedirects: Number(process.env.CRAWLER_MAX_REDIRECTS ?? 5),
          maxRetries: Number(process.env.CRAWLER_MAX_RETRIES ?? 2),
          allowPrivateNetworkForTests:
            process.env.NODE_ENV === 'test' && process.env.SEO_AGENT_TEST_FIXTURE === '1',
          shouldCancel: () => jobCancellationRequested(id, database),
          onProgress: async (progress) => {
            if (Date.now() - lastHeartbeat >= 15_000) {
              await touchJobHeartbeat(id, database);
              await recordJobEvent(id, 'CRAWL_PROGRESS', progress, database);
              lastHeartbeat = Date.now();
            }
          },
        });
        await recordJobEvent(id, 'ROBOTS_FETCHED', crawl.robots, database);
        if (crawl.sitemapUrls.size)
          await recordJobEvent(
            id,
            'SITEMAP_DISCOVERED',
            { urls: crawl.sitemapUrls.size },
            database,
          );
        const issues = analyzePages(crawl.pages, crawl.sitemapUrls);
        const summary = summarizeCrawl(crawl.pages, issues, crawl.discovered, crawl.durationMs);
        await persistCrawlResult(
          { siteId, jobId: id, runId: run.id, crawl, issues, summary },
          database,
        );
        await recordJobEvent(id, 'SEO_ANALYSIS_COMPLETED', { issues: issues.length }, database);
        if (crawl.cancelled) {
          const cancelled = await markJobCancelled(id, summary, pool);
          await recordJobEvent(id, 'CRAWL_CANCELLED', summary, database);
          return { state: 'CANCELLED' as const, job: cancelled };
        }
        const completed = await markJobSucceeded(id, summary, pool);
        await recordJobEvent(id, 'CRAWL_COMPLETED', summary, database);
        return { state: 'SUCCEEDED' as const, job: completed };
      } catch (error) {
        const safe = error instanceof Error ? error : new Error('Unknown crawl error');
        const code = String((error as { code?: string }).code ?? 'CRAWL_FAILED');
        await failCrawlRun(run.id, code, safe.message, database);
        await recordJobEvent(id, 'CRAWL_FAILED', { code, summary: safe.message }, database);
        throw error;
      }
    }
    throw Object.assign(new Error('No handler'), { code: 'NO_HANDLER' });
  } catch (error) {
    const safe = error instanceof Error ? error : new Error('Unknown worker error');
    const failed = await markJobFailed(
      id,
      String((error as { code?: string }).code ?? 'JOB_FAILED'),
      safe.message,
      pool,
    );
    return { state: 'FAILED' as const, job: failed };
  }
}

export async function recover(workerDb: Database, staleMinutes: number) {
  return recoverStaleJobs(staleMinutes, workerDb);
}
