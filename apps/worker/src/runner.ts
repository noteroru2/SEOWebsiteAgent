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
  gscConnectionForSite,
  updateGscAccessToken,
  createGscSyncRun,
  upsertGscRows,
  finishGscSyncRun,
  refreshGscSummary,
  refreshGscCrawlMappings,
  opportunityContext,
  createOpportunityRun,
  loadOpportunityInput,
  persistOpportunityResult,
  finishOpportunityRunFailure,
  type Database,
} from '@seo-agent/database';
import { resourceGuardFromEnv, type ResourceGuard } from '@seo-agent/resource-guard';
import { crawlSite } from '@seo-agent/crawler';
import { analyzePages, summarizeCrawl } from '@seo-agent/seo-engine';
import {
  addCalendarDays,
  calendarDateRange,
  gscIncrementalDatePlan,
  utcCalendarDate,
  type JobType,
} from '@seo-agent/shared';
import type { Pool } from 'pg';
import { generateOpportunitySet } from '@seo-agent/opportunity-engine';
import {
  decryptSecret,
  encryptSecret,
  fetchDatasetPages,
  GSC_DATASETS,
  GoogleSearchConsoleApi,
  refreshGoogleToken,
  type SearchConsoleApi,
} from '@seo-agent/gsc';

export async function executeOne(
  workerId: string,
  pool: Pool,
  guard: ResourceGuard = resourceGuardFromEnv(),
  gscApiOverride?: SearchConsoleApi,
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
    if (type === 'GENERATE_OPPORTUNITIES') {
      const siteId = String(job.site_id ?? '');
      const context = await opportunityContext(siteId, pool);
      const run = await createOpportunityRun(id, context, pool);
      const started = performance.now();
      await recordJobEvent(
        id,
        'OPPORTUNITY_RUN_STARTED',
        { runId: run.id, siteId, engineVersion: run.engine_version },
        database,
      );
      try {
        if (await jobCancellationRequested(id, database)) {
          await finishOpportunityRunFailure(
            run.id,
            'CANCELLED',
            'CANCELLED',
            'Cancelled before generation',
            pool,
          );
          await recordJobEvent(id, 'OPPORTUNITY_RUN_CANCELLED', { runId: run.id }, database);
          return {
            state: 'CANCELLED' as const,
            job: await markJobCancelled(id, { runId: run.id }, pool),
          };
        }
        const input = await loadOpportunityInput(context, pool);
        await touchJobHeartbeat(id, database);
        const generated = generateOpportunitySet(input);
        if (await jobCancellationRequested(id, database)) {
          await finishOpportunityRunFailure(
            run.id,
            'CANCELLED',
            'CANCELLED',
            'Cancelled before persistence',
            pool,
          );
          await recordJobEvent(id, 'OPPORTUNITY_RUN_CANCELLED', { runId: run.id }, database);
          return {
            state: 'CANCELLED' as const,
            job: await markJobCancelled(id, { runId: run.id }, pool),
          };
        }
        const durationMs = Math.round(performance.now() - started);
        const persisted = await persistOpportunityResult(
          run.id,
          siteId,
          generated,
          durationMs,
          pool,
        );
        const result = {
          runId: run.id,
          engineVersion: run.engine_version,
          durationMs,
          candidatesGenerated: generated.candidatesGenerated,
          opportunitiesSuppressed: generated.opportunitiesSuppressed,
          suppressionCounts: generated.suppressionCounts,
          ...persisted,
        };
        await recordJobEvent(id, 'OPPORTUNITY_RUN_COMPLETED', result, database);
        return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
      } catch (error) {
        const safe = error instanceof Error ? error : new Error('Unknown opportunity error');
        const code = String((error as { code?: string }).code ?? 'OPPORTUNITY_GENERATION_FAILED');
        await finishOpportunityRunFailure(run.id, 'FAILED', code, safe.message, pool);
        await recordJobEvent(
          id,
          'OPPORTUNITY_RUN_FAILED',
          { runId: run.id, code, summary: safe.message.slice(0, 200) },
          database,
        );
        throw error;
      }
    }
    if (type === 'GSC_SYNC') {
      const siteId = String(job.site_id ?? '');
      const connection = await gscConnectionForSite(siteId, database);
      if (
        !connection?.mapping ||
        !connection.property ||
        connection.connection.status !== 'CONNECTED'
      )
        throw Object.assign(new Error('Connected and mapped Google property required'), {
          code: 'AUTH_REQUIRED',
        });
      let api = gscApiOverride;
      if (!api) {
        let accessToken = connection.connection.encryptedAccessToken
          ? decryptSecret(connection.connection.encryptedAccessToken)
          : '';
        if (
          !accessToken ||
          !connection.connection.accessTokenExpiresAt ||
          connection.connection.accessTokenExpiresAt.getTime() < Date.now() + 60_000
        ) {
          if (!connection.connection.encryptedRefreshToken)
            throw Object.assign(new Error('Refresh token unavailable'), {
              code: 'TOKEN_REFRESH_FAILED',
            });
          const refreshed = await refreshGoogleToken(
            decryptSecret(connection.connection.encryptedRefreshToken),
          );
          accessToken = refreshed.access_token;
          await updateGscAccessToken(
            connection.connection.id,
            encryptSecret(accessToken),
            new Date(Date.now() + refreshed.expires_in * 1000),
            database,
          );
          await recordJobEvent(id, 'GSC_AUTH_REFRESHED', {}, database);
        }
        api = new GoogleSearchConsoleApi(accessToken);
      }
      const payload = (job.payload ?? {}) as { mode?: string };
      const mode = payload.mode ?? 'INCREMENTAL';
      const now = new Date();
      const endDate = addCalendarDays(utcCalendarDate(now), -3);
      let requestedDates = calendarDateRange(
        addCalendarDays(endDate, -(mode === 'MANUAL_90D' ? 89 : 27)),
        endDate,
      );
      let correctionDates: string[] = [];
      let missingDates: string[] = [];
      if (mode === 'INCREMENTAL') {
        const previous = await pool.query(
          'SELECT last_finalized_date FROM gsc_sync_summaries WHERE site_id=$1',
          [siteId],
        );
        const plan = gscIncrementalDatePlan(now, previous.rows[0]?.last_finalized_date);
        requestedDates = plan.requestedDates;
        correctionDates = plan.correctionDates;
        missingDates = plan.missingDates;
      }
      const startDate = requestedDates[0]!;
      const run = await createGscSyncRun(
        {
          siteId,
          propertyId: connection.property.id,
          jobId: id,
          mode,
          startDate,
          endDate,
        },
        database,
      );
      await recordJobEvent(
        id,
        'GSC_SYNC_STARTED',
        { runId: run.id, mode, startDate, endDate, missingDates, correctionDates },
        database,
      );
      let apiRequests = 0,
        rowsReceived = 0,
        rowsInserted = 0,
        rowsUpdated = 0;
      let coverage = 'COMPLETE_AS_RETURNED';
      let cancelled = false;
      try {
        for (const date of requestedDates) {
          if (cancelled) break;
          for (const dataset of GSC_DATASETS) {
            const result = await fetchDatasetPages({
              api,
              propertyUri: connection.property.propertyUri,
              date,
              dataset,
              shouldCancel: () => jobCancellationRequested(id, database),
              onPage: async (rows) => {
                for (let offset = 0; offset < rows.length; offset += 500) {
                  const written = await upsertGscRows(
                    dataset,
                    { siteId, propertyId: connection.property!.id, searchType: 'web' },
                    rows.slice(offset, offset + 500),
                    pool,
                  );
                  rowsInserted += written.inserted;
                  rowsUpdated += written.updated;
                }
              },
            });
            apiRequests += result.requests;
            rowsReceived += result.rows;
            if (result.coverage === 'POSSIBLY_TRUNCATED') coverage = 'POSSIBLY_TRUNCATED';
            cancelled = result.cancelled;
            await touchJobHeartbeat(id, database);
            if (apiRequests % 10 === 0)
              await recordJobEvent(
                id,
                'GSC_SYNC_PROGRESS',
                { date, dataset, apiRequests, rowsReceived },
                database,
              );
            if (cancelled) break;
          }
        }
        const status = cancelled
          ? 'CANCELLED'
          : coverage === 'POSSIBLY_TRUNCATED'
            ? 'PARTIAL'
            : 'SUCCEEDED';
        await finishGscSyncRun(
          run.id,
          {
            status,
            apiRequests,
            rowsReceived,
            rowsInserted,
            rowsUpdated,
            coverageStatus: cancelled ? 'PARTIAL' : coverage,
          },
          database,
        );
        if (!cancelled) {
          await refreshGscSummary(siteId, connection.property.id, run.id, coverage, pool);
          await refreshGscCrawlMappings(siteId, connection.property.id, pool);
        }
        await recordJobEvent(
          id,
          cancelled
            ? 'GSC_SYNC_CANCELLED'
            : status === 'PARTIAL'
              ? 'GSC_SYNC_PARTIAL'
              : 'GSC_SYNC_COMPLETED',
          { runId: run.id, apiRequests, rowsReceived, rowsInserted, rowsUpdated, coverage },
          database,
        );
        const result = { status, apiRequests, rowsReceived, rowsInserted, rowsUpdated, coverage };
        if (cancelled)
          return { state: 'CANCELLED' as const, job: await markJobCancelled(id, result, pool) };
        return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
      } catch (error) {
        const safe = error instanceof Error ? error : new Error('Unknown GSC error');
        const code = String((error as { code?: string }).code ?? 'GOOGLE_API_ERROR');
        await finishGscSyncRun(
          run.id,
          {
            status: 'FAILED',
            apiRequests,
            rowsReceived,
            rowsInserted,
            rowsUpdated,
            coverageStatus: 'FAILED',
            failureCode: code,
            failureSummary: safe.message,
          },
          database,
        );
        await pool.query(
          `UPDATE gsc_sync_summaries SET latest_status='FAILED',updated_at=now() WHERE site_id=$1`,
          [siteId],
        );
        await recordJobEvent(
          id,
          'GSC_SYNC_FAILED',
          { runId: run.id, code, summary: safe.message.slice(0, 200) },
          database,
        );
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
