import { and, asc, count, desc, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { createSiteSchema, enqueueJobSchema, type JobType } from '@seo-agent/shared';
import type { CrawlResult, ExtractedPage } from '@seo-agent/crawler';
import type { SeoIssue } from '@seo-agent/seo-engine';
import * as schema from './schema';

export * from './schema';
export type Database = ReturnType<typeof drizzle<typeof schema>>;
let singleton: { pool: Pool; db: Database } | undefined;

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  return { pool, db: drizzle(pool, { schema }) };
}

export function databaseForPool(pool: Pool) {
  return drizzle(pool, { schema });
}

export function getDatabase() {
  return (singleton ??= createDatabase());
}

export async function createSite(input: unknown, database = getDatabase().db) {
  const value = createSiteSchema.parse(input);
  const [site] = await database.insert(schema.sites).values(value).returning();
  return site!;
}

export async function enqueueJob(input: unknown, database = getDatabase().db) {
  const value = enqueueJobSchema.parse(input);
  const [job] = await database
    .insert(schema.jobs)
    .values({ type: value.type, siteId: value.siteId, payload: {} })
    .returning();
  await database.insert(schema.jobEvents).values({ jobId: job!.id, event: 'ENQUEUED' });
  return job!;
}

export async function getSite(siteId: string, database = getDatabase().db) {
  const [site] = await database
    .select()
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .limit(1);
  return site;
}

export async function requestJobCancellation(jobId: string, database = getDatabase().db) {
  const [job] = await database.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return job;
  const [updated] = await database
    .update(schema.jobs)
    .set(
      job.status === 'QUEUED'
        ? {
            status: 'CANCELLED',
            finishedAt: new Date(),
            cancellationRequestedAt: new Date(),
            updatedAt: new Date(),
          }
        : { cancellationRequestedAt: new Date(), updatedAt: new Date() },
    )
    .where(eq(schema.jobs.id, jobId))
    .returning();
  if (updated)
    await database.insert(schema.jobEvents).values({ jobId, event: 'CANCELLATION_REQUESTED' });
  return updated;
}

export async function jobCancellationRequested(jobId: string, database = getDatabase().db) {
  const [job] = await database
    .select({
      cancellationRequestedAt: schema.jobs.cancellationRequestedAt,
      status: schema.jobs.status,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  return !job || job.status === 'CANCELLED' || !!job.cancellationRequestedAt;
}

export async function touchJobHeartbeat(jobId: string, database = getDatabase().db) {
  await database
    .update(schema.jobs)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'RUNNING')));
}

export async function markJobCancelled(jobId: string, result: unknown, pool = getDatabase().pool) {
  const response = await pool.query(
    `UPDATE jobs SET status='CANCELLED', result=$2::jsonb, finished_at=NOW(), heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='RUNNING' RETURNING *`,
    [jobId, JSON.stringify(result)],
  );
  if (response.rows[0])
    await pool.query(
      `INSERT INTO job_events(job_id,event,detail) VALUES($1,'CANCELLED',$2::jsonb)`,
      [jobId, JSON.stringify(result)],
    );
  return response.rows[0];
}

export async function recordJobEvent(
  jobId: string,
  event: string,
  detail: unknown = {},
  database = getDatabase().db,
) {
  await database.insert(schema.jobEvents).values({ jobId, event, detail });
}

export async function createCrawlRun(siteId: string, jobId: string, database = getDatabase().db) {
  const [run] = await database
    .insert(schema.crawlRuns)
    .values({ siteId, jobId, status: 'RUNNING', startedAt: new Date() })
    .returning();
  return run!;
}

export async function persistCrawlResult(
  input: {
    siteId: string;
    jobId: string;
    runId: string;
    crawl: CrawlResult;
    issues: SeoIssue[];
    summary: Record<string, unknown>;
  },
  database = getDatabase().db,
) {
  await database.transaction(async (tx) => {
    for (let offset = 0; offset < input.crawl.pages.length; offset += 150) {
      const rows = input.crawl.pages
        .slice(offset, offset + 150)
        .map((page) => pageRow(input.runId, page));
      if (rows.length) await tx.insert(schema.crawlPages).values(rows);
    }
    const ordinary = input.issues.filter(
      (issue) =>
        !['TITLE_DUPLICATE', 'META_DESCRIPTION_DUPLICATE', 'DUPLICATE_CONTENT_HASH'].includes(
          issue.code,
        ),
    );
    for (let offset = 0; offset < ordinary.length; offset += 300) {
      const rows = ordinary.slice(offset, offset + 300).map((issue) => ({
        siteId: input.siteId,
        crawlRunId: input.runId,
        url: issue.url,
        ruleCode: issue.code,
        category: issue.category,
        severity: issue.severity,
        title: issue.summary,
        detail: issue.details ?? {},
      }));
      if (rows.length) await tx.insert(schema.seoIssues).values(rows);
    }
    await tx.execute(
      sql`INSERT INTO seo_issues(site_id,crawl_run_id,url,rule_code,category,severity,title,detail) SELECT ${input.siteId}::uuid,${input.runId}::uuid,p.url,'TITLE_DUPLICATE','TITLE','MEDIUM','Title is shared by multiple crawled URLs',jsonb_build_object('value',p.title) FROM crawl_pages p JOIN (SELECT title FROM crawl_pages WHERE crawl_run_id=${input.runId}::uuid AND nullif(title,'') IS NOT NULL GROUP BY title HAVING count(*)>1) d USING(title) WHERE p.crawl_run_id=${input.runId}::uuid`,
    );
    await tx.execute(
      sql`INSERT INTO seo_issues(site_id,crawl_run_id,url,rule_code,category,severity,title,detail) SELECT ${input.siteId}::uuid,${input.runId}::uuid,p.url,'META_DESCRIPTION_DUPLICATE','DESCRIPTION','MEDIUM','Meta description is shared by multiple crawled URLs',jsonb_build_object('value',p.meta_description) FROM crawl_pages p JOIN (SELECT meta_description FROM crawl_pages WHERE crawl_run_id=${input.runId}::uuid AND nullif(meta_description,'') IS NOT NULL GROUP BY meta_description HAVING count(*)>1) d USING(meta_description) WHERE p.crawl_run_id=${input.runId}::uuid`,
    );
    await tx.execute(
      sql`INSERT INTO seo_issues(site_id,crawl_run_id,url,rule_code,category,severity,title,detail) SELECT ${input.siteId}::uuid,${input.runId}::uuid,p.url,'DUPLICATE_CONTENT_HASH','CONTENT','MEDIUM','Content hash is shared by multiple crawled URLs',jsonb_build_object('hash',p.content_hash) FROM crawl_pages p JOIN (SELECT content_hash FROM crawl_pages WHERE crawl_run_id=${input.runId}::uuid AND content_hash IS NOT NULL GROUP BY content_hash HAVING count(*)>1) d USING(content_hash) WHERE p.crawl_run_id=${input.runId}::uuid`,
    );
    const [issueCount] = await tx
      .select({ value: count() })
      .from(schema.seoIssues)
      .where(eq(schema.seoIssues.crawlRunId, input.runId));
    const pagesSucceeded = input.crawl.pages.filter(
      (page) => (page.statusCode ?? 0) >= 200 && (page.statusCode ?? 0) < 400,
    ).length;
    const pagesIndexable = input.crawl.pages.filter((page) => page.indexable).length;
    await tx
      .update(schema.crawlRuns)
      .set({
        status: input.crawl.cancelled ? 'CANCELLED' : 'SUCCEEDED',
        pagesCrawled: input.crawl.pages.length,
        pagesDiscovered: input.crawl.discovered,
        pagesRequested: input.crawl.requested,
        pagesSucceeded,
        pagesFailed: input.crawl.pages.length - pagesSucceeded,
        pagesIndexable,
        pagesNonIndexable: input.crawl.pages.length - pagesIndexable,
        issuesFound: issueCount!.value,
        durationMs: input.crawl.durationMs,
        robotsMeta: input.crawl.robots,
        summary: { ...input.summary, issues: issueCount!.value },
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.crawlRuns.id, input.runId));
  });
}

function pageRow(runId: string, page: ExtractedPage) {
  return {
    crawlRunId: runId,
    url: page.url,
    finalUrl: page.finalUrl,
    statusCode: page.statusCode,
    redirectCount: page.redirectCount,
    contentType: page.contentType,
    responseBytes: page.responseBytes,
    responseTimeMs: page.responseTimeMs,
    title: page.title,
    titleLength: page.titleLength,
    metaDescription: page.metaDescription,
    descriptionLength: page.descriptionLength,
    h1Count: page.h1Count,
    primaryH1: page.primaryH1,
    h2Count: page.h2Count,
    canonicalUrl: page.canonicalUrl,
    canonicalCount: page.canonicalCount,
    robotsMeta: page.robotsMeta,
    xRobotsTag: page.xRobotsTag,
    indexable: page.indexable,
    indexabilityReasons: page.indexabilityReasons,
    wordCount: page.wordCount,
    internalLinksCount: page.internalLinks.length,
    externalLinksCount: page.externalLinksCount,
    nofollowInternalCount: page.nofollowInternalCount,
    contentHash: page.contentHash,
    crawlDepth: page.crawlDepth,
    discoverySource: page.discoverySource,
    inSitemap: page.inSitemap,
    language: page.language,
    viewportPresent: page.viewportPresent,
    fetchedAt: page.fetchedAt,
    fetchErrorCode: page.fetchErrorCode,
    summary: { bodyTooLarge: page.bodyTooLarge },
  };
}

export async function failCrawlRun(
  runId: string,
  code: string,
  summary: string,
  database = getDatabase().db,
) {
  await database
    .update(schema.crawlRuns)
    .set({
      status: 'FAILED',
      failureCode: code,
      failureSummary: summary.slice(0, 500),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlRuns.id, runId));
}

export async function claimNextJob(workerId: string, pool = getDatabase().pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(820241)');
    const result = await client.query(
      `UPDATE jobs SET status='RUNNING', worker_id=$1, attempt_count=attempt_count+1, started_at=NOW(), heartbeat_at=NOW(), updated_at=NOW() WHERE id=(SELECT id FROM jobs WHERE status='QUEUED' AND available_at<=NOW() AND attempt_count<max_attempts AND (heavy=false OR NOT EXISTS (SELECT 1 FROM jobs WHERE status='RUNNING' AND heavy=true)) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      [workerId],
    );
    if (result.rows[0])
      await client.query(
        `INSERT INTO job_events(job_id,event,detail) VALUES($1,'CLAIMED',jsonb_build_object('workerId',$2::text))`,
        [result.rows[0].id, workerId],
      );
    await client.query('COMMIT');
    return result.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finishJob(
  client: PoolClient,
  jobId: string,
  status: 'SUCCEEDED' | 'FAILED',
  fields: { result?: unknown; code?: string; summary?: string },
) {
  await client.query('BEGIN');
  const result = await client.query(
    `UPDATE jobs SET status=$2::job_status, result=$3::jsonb, failure_code=$4, failure_summary=$5, finished_at=NOW(), heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='RUNNING' RETURNING *`,
    [
      jobId,
      status,
      JSON.stringify(fields.result ?? null),
      fields.code ?? null,
      fields.summary?.slice(0, 500) ?? null,
    ],
  );
  if (result.rows[0])
    await client.query('INSERT INTO job_events(job_id,event,detail) VALUES($1,$2,$3::jsonb)', [
      jobId,
      status,
      JSON.stringify(fields),
    ]);
  await client.query('COMMIT');
  return result.rows[0];
}

export async function markJobSucceeded(jobId: string, result: unknown, pool = getDatabase().pool) {
  const client = await pool.connect();
  try {
    return await finishJob(client, jobId, 'SUCCEEDED', { result });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function markJobFailed(
  jobId: string,
  code: string,
  summary: string,
  pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    return await finishJob(client, jobId, 'FAILED', { code, summary });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function recoverStaleJobs(staleMinutes: number, database = getDatabase().db) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const recovered = await database
    .update(schema.jobs)
    .set({
      status: 'QUEUED',
      workerId: null,
      startedAt: null,
      heartbeatAt: null,
      failureCode: 'WORKER_LOST',
      failureSummary: 'Recovered after worker heartbeat became stale',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.jobs.status, 'RUNNING'),
        lt(schema.jobs.heartbeatAt, cutoff),
        sql`${schema.jobs.attemptCount} < ${schema.jobs.maxAttempts}`,
      ),
    )
    .returning();
  for (const job of recovered)
    await database.insert(schema.jobEvents).values({ jobId: job.id, event: 'RECOVERED' });
  return recovered;
}

export async function dashboardSummary(database = getDatabase().db) {
  const started = performance.now();
  const [[siteCount], [running], [pending], [queued], [aiCost], [worker]] = await Promise.all([
    database.select({ value: count() }).from(schema.sites),
    database.select({ value: count() }).from(schema.jobs).where(eq(schema.jobs.status, 'RUNNING')),
    database
      .select({ value: count() })
      .from(schema.approvals)
      .where(eq(schema.approvals.status, 'PENDING')),
    database.select({ value: count() }).from(schema.jobs).where(eq(schema.jobs.status, 'QUEUED')),
    database
      .select({ value: sql<number>`coalesce(sum(${schema.aiUsage.costMicros}),0)` })
      .from(schema.aiUsage),
    database
      .select()
      .from(schema.systemEvents)
      .where(eq(schema.systemEvents.source, 'worker'))
      .orderBy(desc(schema.systemEvents.createdAt))
      .limit(1),
  ]);
  const recentJobs = await database
    .select()
    .from(schema.jobs)
    .orderBy(desc(schema.jobs.createdAt))
    .limit(5);
  return {
    sites: siteCount!.value,
    running: running!.value,
    pending: pending!.value,
    queued: queued!.value,
    aiCostMicros: Number(aiCost!.value),
    workerHealthy: !!worker && Date.now() - worker.createdAt.getTime() < 60_000,
    recentJobs,
    timingMs: performance.now() - started,
  };
}

export async function listSites(database = getDatabase().db) {
  const started = performance.now();
  const rows = await database
    .select({
      id: schema.sites.id,
      name: schema.sites.name,
      url: schema.sites.url,
      active: schema.sites.active,
      crawlEnabled: schema.sites.crawlEnabled,
      maxPages: schema.sites.maxPages,
      crawlDelayMs: schema.sites.crawlDelayMs,
      requestTimeoutMs: schema.sites.requestTimeoutMs,
      createdAt: schema.sites.createdAt,
      updatedAt: schema.sites.updatedAt,
      lastCrawlAt: sql<Date | null>`(select finished_at from crawl_runs where site_id=${schema.sites.id} order by created_at desc limit 1)`,
      crawlStatus: sql<
        string | null
      >`(select status from crawl_runs where site_id=${schema.sites.id} order by created_at desc limit 1)`,
      pagesCrawled: sql<number>`coalesce((select pages_crawled from crawl_runs where site_id=${schema.sites.id} order by created_at desc limit 1),0)`,
      indexablePages: sql<number>`coalesce((select pages_indexable from crawl_runs where site_id=${schema.sites.id} order by created_at desc limit 1),0)`,
      issueCount: sql<number>`coalesce((select issues_found from crawl_runs where site_id=${schema.sites.id} order by created_at desc limit 1),0)`,
    })
    .from(schema.sites)
    .orderBy(asc(schema.sites.name))
    .limit(100);
  return { rows, timingMs: performance.now() - started };
}

export async function siteDetail(
  siteId: string,
  filters: { severity?: string; category?: string; code?: string } = {},
  database = getDatabase().db,
) {
  const site = await getSite(siteId, database);
  if (!site) return null;
  const [latest] = await database
    .select()
    .from(schema.crawlRuns)
    .where(eq(schema.crawlRuns.siteId, siteId))
    .orderBy(desc(schema.crawlRuns.createdAt))
    .limit(1);
  const conditions = latest ? [eq(schema.seoIssues.crawlRunId, latest.id)] : [];
  if (filters.severity) conditions.push(eq(schema.seoIssues.severity, filters.severity));
  if (filters.category) conditions.push(eq(schema.seoIssues.category, filters.category));
  if (filters.code) conditions.push(eq(schema.seoIssues.ruleCode, filters.code));
  const issues = latest
    ? await database
        .select()
        .from(schema.seoIssues)
        .where(and(...conditions))
        .orderBy(desc(schema.seoIssues.detectedAt))
        .limit(100)
    : [];
  const runningJob = await database
    .select()
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.siteId, siteId),
        eq(schema.jobs.type, 'SITE_CRAWL'),
        eq(schema.jobs.status, 'RUNNING'),
      ),
    )
    .limit(1);
  return { site, latest, issues, runningJob: runningJob[0] ?? null };
}
export async function listJobs(database = getDatabase().db) {
  const started = performance.now();
  const rows = await database
    .select()
    .from(schema.jobs)
    .orderBy(desc(schema.jobs.createdAt))
    .limit(100);
  return { rows, timingMs: performance.now() - started };
}
export async function recordWorkerHeartbeat(workerId: string, database = getDatabase().db) {
  await database
    .insert(schema.systemEvents)
    .values({ source: 'worker', level: 'INFO', event: 'HEARTBEAT', detail: { workerId } });
}
export async function databaseHealthy(pool = getDatabase().pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
export const registeredJobTypes: ReadonlySet<JobType> = new Set(['SYSTEM_TEST', 'SITE_CRAWL']);
