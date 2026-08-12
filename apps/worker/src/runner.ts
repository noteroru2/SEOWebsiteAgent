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
  prepareAiAnalysis,
  persistAiAnalysisSuccess,
  persistAiAnalysisFailure,
  recordAiFailedRequest,
  sourceRepositoryForSite,
  persistSourceRefresh,
  opportunitySourceInput,
  createSourcePlanRun,
  persistSourcePlanSuccess,
  failSourcePlanRun,
  missingDatesForWindow,
  deterministicEvidencePacket,
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
import { aiConfigFromEnv, OpenAiResponsesProvider, type ReasoningProvider } from '@seo-agent/ai';
import {
  OpenAiSourcePlanProvider,
  SOURCE_PLAN_EVIDENCE_PROMPT_VERSION,
  SOURCE_PLAN_PROMPT_VERSION,
  buildSourceContext,
  boundSourceExcerpt,
  deriveAstroProjectMappings,
  inspectRepository,
  resolveWorkerRepositoryPath,
  type RouteMapping,
  type SourceContext,
  type SourcePlanProvider,
} from '@seo-agent/source-understanding';
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
  aiProviderOverride?: ReasoningProvider,
  sourcePlanProviderOverride?: SourcePlanProvider,
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
    if (type === 'REFRESH_SOURCE_REPOSITORY') {
      const siteId = String(job.site_id ?? '');
      const [site, repository] = await Promise.all([
        getSite(siteId, database),
        sourceRepositoryForSite(siteId, pool),
      ]);
      if (!site || !repository)
        throw Object.assign(new Error('Source repository configuration required'), {
          code: 'SOURCE_REPOSITORY_NOT_CONFIGURED',
        });
      await recordJobEvent(
        id,
        'SOURCE_REPOSITORY_REFRESH_STARTED',
        { siteId, repositoryId: repository.id },
        database,
      );
      const started = performance.now();
      const state = await inspectRepository(
        resolveWorkerRepositoryPath(String(repository.local_path)),
      );
      if (repository.expected_remote && state.originUrl !== repository.expected_remote)
        throw Object.assign(new Error('Source repository remote does not match configuration'), {
          code: 'SOURCE_REMOTE_MISMATCH',
        });
      if (repository.default_branch && state.branch !== repository.default_branch)
        throw Object.assign(new Error('Source repository branch does not match configuration'), {
          code: 'SOURCE_BRANCH_MISMATCH',
        });
      const mappings = await deriveAstroProjectMappings(state);
      const result = await persistSourceRefresh(
        {
          siteId,
          repositoryId: String(repository.id),
          siteUrl: site.url,
          state,
          mappings,
          durationMs: Math.round(performance.now() - started),
        },
        pool,
      );
      await recordJobEvent(id, 'SOURCE_MAPPING_UPDATED', result, database);
      return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
    }
    if (type === 'GENERATE_SOURCE_CHANGE_PLAN') {
      const payload = (job.payload ?? {}) as {
        opportunityId?: string;
        evidenceReevaluation?: boolean;
        evidencePacketHash?: string;
      };
      if (!payload.opportunityId)
        throw Object.assign(new Error('Opportunity id is required'), {
          code: 'OPPORTUNITY_REQUIRED',
        });
      let runId: string | undefined;
      try {
        const source = await opportunitySourceInput(payload.opportunityId, pool);
        const evidence = payload.evidenceReevaluation
          ? await deterministicEvidencePacket(payload.opportunityId, pool)
          : null;
        if (
          evidence &&
          payload.evidencePacketHash &&
          payload.evidencePacketHash !== evidence.evidencePacketHash
        )
          throw Object.assign(new Error('Evidence changed after the job was queued'), {
            code: 'EVIDENCE_CHANGED',
          });
        if (evidence && evidence.completeness !== 'READY_FOR_REEVALUATION')
          throw Object.assign(new Error('Required evidence is not ready for re-evaluation'), {
            code: 'EVIDENCE_INCOMPLETE',
          });
        const deterministic = source.mappings.filter(
          (item) => !['UNRESOLVED', 'AMBIGUOUS'].includes(String(item.mapping_status)),
        );
        if (!deterministic.length || deterministic.length !== source.routes.length)
          throw Object.assign(
            new Error('Every opportunity URL requires deterministic source mapping'),
            { code: 'SOURCE_MAPPING_REQUIRED' },
          );
        const repositoryState = await inspectRepository(
          resolveWorkerRepositoryPath(String(source.repository.local_path)),
        );
        if (!repositoryState.clean || repositoryState.headSha !== source.repository.head_sha)
          throw Object.assign(new Error('Repository state changed after source refresh'), {
            code: 'SOURCE_REPOSITORY_STALE',
          });
        const contexts: SourceContext[] = [];
        for (const item of deterministic) {
          const mapping: RouteMapping = {
            routePath: item.route_path,
            status: item.mapping_status,
            primarySourcePath: item.primary_source_path,
            relatedSourcePaths: item.related_source_paths ?? [],
            evidence: item.mapping_evidence ?? {},
          };
          contexts.push(await buildSourceContext(repositoryState, mapping));
        }
        const primaryPaths = contexts
          .map((item) => item.routeMapping.primarySourcePath)
          .filter(Boolean) as string[];
        const allFiles = contexts.flatMap((item) => item.files);
        const files = [
          ...primaryPaths.map((primary) => allFiles.find((file) => file.path === primary)!),
          ...allFiles,
        ]
          .filter(Boolean)
          .filter(
            (file, index, all) =>
              all.findIndex((candidate) => candidate.path === file.path) === index,
          )
          .slice(0, 6);
        let remaining = 40_000;
        const boundedFiles = files
          .map((file) => {
            const excerpt = file.excerpts[0]!;
            const bounded = boundSourceExcerpt(excerpt, remaining);
            remaining -= bounded.actualCharacters;
            return { ...file, excerpts: [bounded] };
          })
          .filter((file) => file.excerpts[0]!.text.length);
        let context: SourceContext = {
          repository: contexts[0]!.repository,
          routeMapping:
            contexts.length === 1
              ? contexts[0]!.routeMapping
              : {
                  routePath: source.routes.join(' | '),
                  status: 'MULTI_FILE_COMPOSITION',
                  primarySourcePath: contexts[0]!.routeMapping.primarySourcePath,
                  relatedSourcePaths: contexts
                    .slice(1)
                    .map((item) => item.routeMapping.primarySourcePath!)
                    .filter(Boolean),
                  evidence: { routes: source.routes },
                },
          files: boundedFiles,
          totalCharacters: 40_000 - remaining,
          redactions: boundedFiles.filter((file) => file.redacted).length,
        };
        const evidenceSourceContext = evidence?.packet.targetedSourceContext.at(-1) as
          SourceContext | undefined;
        if (evidenceSourceContext) context = evidenceSourceContext;
        const prepared = await createSourcePlanRun(
          { jobId: id, source, context, evidencePacket: evidence?.packet },
          pool,
        );
        runId = String(prepared.run.id);
        if (prepared.reused) {
          const result = {
            sourcePlanRunId: runId,
            reusedRunId: prepared.run.reused_run_id,
            reused: true,
          };
          await recordJobEvent(id, 'SOURCE_PLAN_REUSED', result, database);
          return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
        }
        await recordJobEvent(
          id,
          'SOURCE_PLAN_STARTED',
          {
            sourcePlanRunId: runId,
            opportunityId: payload.opportunityId,
            model: 'gpt-5.6-terra',
            promptVersion: evidence
              ? SOURCE_PLAN_EVIDENCE_PROMPT_VERSION
              : SOURCE_PLAN_PROMPT_VERSION,
          },
          database,
        );
        const provider =
          sourcePlanProviderOverride ??
          new OpenAiSourcePlanProvider(process.env.OPENAI_API_KEY ?? '');
        const analysis = await provider.generate(
          {
            opportunity: source.opportunity,
            batch5: source.batch5,
            context,
            evidencePacket: evidence?.packet,
          },
          AbortSignal.timeout(Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 60_000)),
        );
        const persisted = await persistSourcePlanSuccess(prepared.run, analysis, pool);
        const result = {
          sourcePlanRunId: runId,
          planId: persisted.plan.id,
          reused: false,
          verdict: analysis.result.verdict,
          inputTokens: analysis.inputTokens,
          cachedInputTokens: analysis.cachedInputTokens,
          outputTokens: analysis.outputTokens,
          costMicros: persisted.costMicros,
        };
        await recordJobEvent(id, 'SOURCE_PLAN_COMPLETED', result, database);
        return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'SOURCE_PLAN_FAILED');
        const summary = error instanceof Error ? error.message : 'Source plan failed';
        if (runId) await failSourcePlanRun(runId, code, summary, pool);
        await recordJobEvent(
          id,
          'SOURCE_PLAN_FAILED',
          {
            sourcePlanRunId: runId,
            opportunityId: payload.opportunityId,
            code,
            summary: summary.slice(0, 200),
          },
          database,
        );
        throw error;
      }
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
    if (type === 'ANALYZE_OPPORTUNITY') {
      const siteId = String(job.site_id ?? '');
      const payload = (job.payload ?? {}) as { opportunityId?: string; reanalyze?: boolean };
      if (!payload.opportunityId)
        throw Object.assign(new Error('Opportunity id is required'), {
          code: 'OPPORTUNITY_REQUIRED',
        });
      const config = aiConfigFromEnv();
      let analysisRunId: string | undefined;
      try {
        const prepared = await prepareAiAnalysis(
          {
            jobId: id,
            siteId,
            opportunityId: payload.opportunityId,
            force: payload.reanalyze === true,
            config,
          },
          pool,
        );
        analysisRunId = String(prepared.run.id);
        if (prepared.reused) {
          const result = { analysisRunId, reusedRunId: prepared.reusedRunId, reused: true };
          await recordJobEvent(id, 'AI_ANALYSIS_REUSED', result, database);
          return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
        }
        await recordJobEvent(
          id,
          'AI_ANALYSIS_STARTED',
          {
            analysisRunId,
            opportunityId: payload.opportunityId,
            model: config.model,
            promptVersion: prepared.run.prompt_version,
          },
          database,
        );
        if (await jobCancellationRequested(id, database))
          throw Object.assign(new Error('Cancelled before provider request'), {
            code: 'AI_CANCELLED',
          });
        const provider =
          aiProviderOverride ?? new OpenAiResponsesProvider(process.env.OPENAI_API_KEY ?? '');
        let analysis;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            analysis = await provider.analyze(
              prepared.context,
              config,
              AbortSignal.timeout(Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 60_000)),
            );
            break;
          } catch (error) {
            await recordAiFailedRequest(prepared.run, pool);
            if (!(error as { transient?: boolean }).transient || attempt === 1) throw error;
            await recordJobEvent(
              id,
              'AI_ANALYSIS_RETRY',
              {
                analysisRunId,
                attempt: attempt + 1,
                code: String((error as { code?: string }).code ?? 'AI_PROVIDER_ERROR'),
              },
              database,
            );
          }
        }
        if (!analysis)
          throw Object.assign(new Error('AI provider returned no analysis'), {
            code: 'AI_INCOMPLETE_RESPONSE',
          });
        if (await jobCancellationRequested(id, database))
          throw Object.assign(new Error('Cancelled before recommendation persistence'), {
            code: 'AI_CANCELLED',
          });
        const persisted = await persistAiAnalysisSuccess(prepared.run, analysis, pool);
        const result = {
          analysisRunId,
          reused: false,
          model: config.model,
          verdict: analysis.result.verdict,
          confidence: analysis.result.confidence,
          inputTokens: analysis.inputTokens,
          cachedInputTokens: analysis.cachedInputTokens,
          outputTokens: analysis.outputTokens,
          latencyMs: analysis.latencyMs,
          costMicros: persisted.costMicros,
        };
        await recordJobEvent(id, 'AI_ANALYSIS_COMPLETED', result, database);
        return { state: 'SUCCEEDED' as const, job: await markJobSucceeded(id, result, pool) };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'AI_PROVIDER_ERROR');
        const summary = error instanceof Error ? error.message : 'AI analysis failed';
        analysisRunId ??= (error as { analysisRunId?: string }).analysisRunId;
        if (analysisRunId && code !== 'AI_BUDGET_EXCEEDED')
          await persistAiAnalysisFailure(analysisRunId, code, summary, pool);
        await recordJobEvent(
          id,
          code === 'AI_BUDGET_EXCEEDED'
            ? 'AI_BUDGET_BLOCKED'
            : code === 'AI_CANCELLED'
              ? 'AI_ANALYSIS_CANCELLED'
              : 'AI_ANALYSIS_FAILED',
          {
            analysisRunId,
            opportunityId: payload.opportunityId,
            code,
            summary: summary.slice(0, 200),
          },
          database,
        );
        if (code === 'AI_CANCELLED')
          return {
            state: 'CANCELLED' as const,
            job: await markJobCancelled(id, { analysisRunId }, pool),
          };
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
      if (mode === 'EVIDENCE_PREVIOUS_28D') {
        const previous = await pool.query(
          `SELECT to_char(last_finalized_date,'YYYY-MM-DD') last_date FROM gsc_sync_summaries WHERE site_id=$1`,
          [siteId],
        );
        const lastDate = previous.rows[0]?.last_date;
        if (!lastDate)
          throw Object.assign(new Error('Finalized GSC window required'), {
            code: 'GSC_DATA_REQUIRED',
          });
        const previousStart = addCalendarDays(lastDate, -55);
        const previousEnd = addCalendarDays(lastDate, -28);
        const stored = await pool.query(
          `SELECT to_char(metric_date,'YYYY-MM-DD') date FROM gsc_daily_site_metrics
           WHERE site_id=$1 AND property_id=$2 AND metric_date BETWEEN $3 AND $4`,
          [siteId, connection.property.id, previousStart, previousEnd],
        );
        requestedDates = missingDatesForWindow(
          { start: previousStart, end: previousEnd },
          stored.rows.map((row) => row.date),
        );
        missingDates = [...requestedDates];
        if (!requestedDates.length)
          return {
            state: 'SUCCEEDED' as const,
            job: await markJobSucceeded(
              id,
              {
                status: 'SUCCEEDED',
                apiRequests: 0,
                rowsReceived: 0,
                rowsInserted: 0,
                rowsUpdated: 0,
                coverage: 'COMPLETE_AS_RETURNED',
              },
              pool,
            ),
          };
      }
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
