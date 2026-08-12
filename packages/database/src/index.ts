import { and, asc, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { createSiteSchema, enqueueJobSchema, type JobType } from '@seo-agent/shared';
import type { CrawlResult, ExtractedPage } from '@seo-agent/crawler';
import type { SeoIssue } from '@seo-agent/seo-engine';
import * as schema from './schema';

export * from './schema';
export * from './opportunities';
export * from './ai-recommendations';
export * from './source-plans';
export * from './evidence-resolution';
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
  const deduplicatedTypes = [
    'GSC_SYNC',
    'GENERATE_OPPORTUNITIES',
    'ANALYZE_OPPORTUNITY',
    'REFRESH_SOURCE_REPOSITORY',
    'GENERATE_SOURCE_CHANGE_PLAN',
  ];
  const insert = database.insert(schema.jobs).values({
    type: value.type,
    siteId: value.siteId,
    heavy: !deduplicatedTypes.includes(value.type),
    payload: ['ANALYZE_OPPORTUNITY', 'GENERATE_SOURCE_CHANGE_PLAN'].includes(value.type)
      ? {
          opportunityId: value.opportunityId,
          reanalyze: value.reanalyze === true,
          evidenceReevaluation: value.evidenceReevaluation === true,
        }
      : value.mode
        ? { mode: value.mode }
        : {},
  });
  const [job] = deduplicatedTypes.includes(value.type)
    ? await insert.onConflictDoNothing().returning()
    : await insert.returning();
  if (!job && deduplicatedTypes.includes(value.type) && value.siteId) {
    const opportunityCondition = ['ANALYZE_OPPORTUNITY', 'GENERATE_SOURCE_CHANGE_PLAN'].includes(
      value.type,
    )
      ? sql`${schema.jobs.payload}->>'opportunityId' = ${value.opportunityId}`
      : undefined;
    const [active] = await database
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.siteId, value.siteId),
          eq(schema.jobs.type, value.type),
          inArray(schema.jobs.status, ['QUEUED', 'RUNNING']),
          opportunityCondition,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(1);
    if (active) return active;
    throw new Error(`Active ${value.type} job could not be resolved`);
  }
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
      `UPDATE jobs SET status='RUNNING', worker_id=$1, attempt_count=attempt_count+1, started_at=NOW(), heartbeat_at=NOW(), updated_at=NOW()
       WHERE id=(SELECT candidate.id FROM jobs candidate
        WHERE candidate.status='QUEUED' AND candidate.available_at<=NOW()
         AND candidate.attempt_count<candidate.max_attempts
         AND (candidate.heavy=false OR NOT EXISTS (SELECT 1 FROM jobs running WHERE running.status='RUNNING' AND running.heavy=true))
         AND (candidate.type<>'ANALYZE_OPPORTUNITY' OR NOT EXISTS (
           SELECT 1 FROM jobs running_ai WHERE running_ai.status='RUNNING' AND running_ai.type='ANALYZE_OPPORTUNITY'
         ))
        ORDER BY candidate.created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
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
export const registeredJobTypes: ReadonlySet<JobType> = new Set([
  'SYSTEM_TEST',
  'SITE_CRAWL',
  'GSC_SYNC',
  'GENERATE_OPPORTUNITIES',
  'ANALYZE_OPPORTUNITY',
  'REFRESH_SOURCE_REPOSITORY',
  'GENERATE_SOURCE_CHANGE_PLAN',
]);

export async function createGscOAuthState(
  siteId: string,
  stateHash: string,
  database = getDatabase().db,
) {
  const [row] = await database
    .insert(schema.gscOAuthStates)
    .values({ siteId, stateHash, expiresAt: new Date(Date.now() + 10 * 60_000) })
    .returning();
  return row!;
}

export async function consumeGscOAuthState(stateHash: string, database = getDatabase().db) {
  const [row] = await database
    .update(schema.gscOAuthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.gscOAuthStates.stateHash, stateHash),
        sql`${schema.gscOAuthStates.consumedAt} IS NULL`,
        sql`${schema.gscOAuthStates.expiresAt} > now()`,
      ),
    )
    .returning();
  return row;
}

export async function saveGscConnection(
  input: {
    siteId: string;
    encryptedRefreshToken: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: Date;
    scope: string;
    properties: Array<{ propertyUri: string; permissionLevel: string }>;
  },
  pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connection = await client.query(
      `INSERT INTO gsc_connections(site_id,encrypted_refresh_token,encrypted_access_token,access_token_expires_at,scope,status) VALUES($1,$2,$3,$4,$5,'CONNECTED') ON CONFLICT(site_id) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token,encrypted_access_token=excluded.encrypted_access_token,access_token_expires_at=excluded.access_token_expires_at,scope=excluded.scope,status='CONNECTED',disconnected_at=NULL,last_error_code=NULL,updated_at=now() RETURNING *`,
      [
        input.siteId,
        input.encryptedRefreshToken,
        input.encryptedAccessToken,
        input.accessTokenExpiresAt,
        input.scope,
      ],
    );
    const id = connection.rows[0].id as string;
    for (const property of input.properties)
      await client.query(
        `INSERT INTO gsc_properties(connection_id,property_uri,property_type,permission_level,last_discovered_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(connection_id,property_uri) DO UPDATE SET property_type=excluded.property_type,permission_level=excluded.permission_level,last_discovered_at=now(),updated_at=now()`,
        [
          id,
          property.propertyUri,
          property.propertyUri.startsWith('sc-domain:') ? 'DOMAIN' : 'URL_PREFIX',
          property.permissionLevel,
        ],
      );
    await client.query(
      `INSERT INTO system_events(source,level,event,detail) VALUES('gsc','INFO','GSC_PROPERTY_DISCOVERED',jsonb_build_object('siteId',$1::text,'count',$2::int))`,
      [input.siteId, input.properties.length],
    );
    await client.query('COMMIT');
    return connection.rows[0] as Record<string, unknown>;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function mapGscProperty(
  siteId: string,
  propertyId: string,
  database = getDatabase().db,
) {
  const [connection] = await database
    .select()
    .from(schema.gscConnections)
    .where(
      and(eq(schema.gscConnections.siteId, siteId), eq(schema.gscConnections.status, 'CONNECTED')),
    )
    .limit(1);
  if (!connection)
    throw Object.assign(new Error('Google connection required'), { code: 'AUTH_REQUIRED' });
  const [property] = await database
    .select()
    .from(schema.gscProperties)
    .where(
      and(
        eq(schema.gscProperties.id, propertyId),
        eq(schema.gscProperties.connectionId, connection.id),
      ),
    )
    .limit(1);
  if (!property)
    throw Object.assign(new Error('Property is not available to this connection'), {
      code: 'INVALID_PROPERTY',
    });
  const [mapped] = await database
    .insert(schema.siteGscProperties)
    .values({ siteId, propertyId, connectionId: connection.id })
    .onConflictDoUpdate({
      target: schema.siteGscProperties.siteId,
      set: { propertyId, connectionId: connection.id, syncEnabled: true, updatedAt: new Date() },
    })
    .returning();
  await database.insert(schema.systemEvents).values({
    source: 'gsc',
    level: 'INFO',
    event: 'GSC_PROPERTY_MAPPED',
    detail: { siteId, propertyUri: property.propertyUri, source: 'USER_SELECTED' },
  });
  return mapped!;
}

export async function disconnectGsc(siteId: string, database = getDatabase().db) {
  await database
    .update(schema.siteGscProperties)
    .set({ syncEnabled: false, updatedAt: new Date() })
    .where(eq(schema.siteGscProperties.siteId, siteId));
  const [row] = await database
    .update(schema.gscConnections)
    .set({
      encryptedRefreshToken: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      status: 'DISCONNECTED',
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.gscConnections.siteId, siteId))
    .returning();
  return row;
}

export async function gscConnectionForSite(siteId: string, database = getDatabase().db) {
  const [row] = await database
    .select({
      connection: schema.gscConnections,
      mapping: schema.siteGscProperties,
      property: schema.gscProperties,
    })
    .from(schema.gscConnections)
    .leftJoin(
      schema.siteGscProperties,
      eq(schema.siteGscProperties.connectionId, schema.gscConnections.id),
    )
    .leftJoin(
      schema.gscProperties,
      eq(schema.gscProperties.id, schema.siteGscProperties.propertyId),
    )
    .where(eq(schema.gscConnections.siteId, siteId))
    .limit(1);
  return row;
}

export async function updateGscAccessToken(
  connectionId: string,
  encryptedAccessToken: string,
  expiresAt: Date,
  database = getDatabase().db,
) {
  await database
    .update(schema.gscConnections)
    .set({ encryptedAccessToken, accessTokenExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(schema.gscConnections.id, connectionId));
}

export async function createGscSyncRun(
  input: {
    siteId: string;
    propertyId: string;
    jobId: string;
    mode: string;
    startDate: string;
    endDate: string;
  },
  database = getDatabase().db,
) {
  const [row] = await database.insert(schema.gscSyncRuns).values(input).returning();
  return row!;
}

export async function upsertGscRows(
  dataset: 'SITE' | 'QUERY' | 'PAGE' | 'QUERY_PAGE',
  identity: { siteId: string; propertyId: string; searchType: string },
  rows: Array<{
    date: string;
    query?: string;
    page?: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>,
  pool = getDatabase().pool,
) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const table =
    dataset === 'SITE'
      ? 'gsc_daily_site_metrics'
      : dataset === 'QUERY'
        ? 'gsc_query_metrics'
        : dataset === 'PAGE'
          ? 'gsc_page_metrics'
          : 'gsc_query_page_metrics';
  const extra =
    dataset === 'QUERY'
      ? ['query']
      : dataset === 'PAGE'
        ? ['page']
        : dataset === 'QUERY_PAGE'
          ? ['query', 'page']
          : [];
  const columns = [
    'site_id',
    'property_id',
    'search_type',
    'metric_date',
    ...extra,
    'clicks',
    'impressions',
    'ctr',
    'position',
  ];
  const width = columns.length;
  const params: unknown[] = [];
  const values = rows.map((row, rowIndex) => {
    params.push(
      identity.siteId,
      identity.propertyId,
      identity.searchType,
      row.date,
      ...extra.map((key) => row[key as 'query' | 'page'] ?? ''),
      row.clicks,
      row.impressions,
      row.ctr,
      row.position,
    );
    return `(${Array.from({ length: width }, (_, i) => `$${rowIndex * width + i + 1}`).join(',')})`;
  });
  const conflict = ['site_id', 'property_id', 'search_type', 'metric_date', ...extra].join(',');
  const result = await pool.query(
    `INSERT INTO ${table}(${columns.join(',')}) VALUES ${values.join(',')} ON CONFLICT(${conflict}) DO UPDATE SET clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr,position=excluded.position,updated_at=now() RETURNING (xmax=0) AS inserted`,
    params,
  );
  const inserted = result.rows.filter((row) => row.inserted).length;
  return { inserted, updated: result.rowCount! - inserted };
}

export async function finishGscSyncRun(
  runId: string,
  fields: {
    status: string;
    apiRequests: number;
    rowsReceived: number;
    rowsInserted: number;
    rowsUpdated: number;
    coverageStatus: string;
    failureCode?: string;
    failureSummary?: string;
  },
  database = getDatabase().db,
) {
  const [row] = await database
    .update(schema.gscSyncRuns)
    .set({
      ...fields,
      failureSummary: fields.failureSummary?.slice(0, 500),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.gscSyncRuns.id, runId))
    .returning();
  return row!;
}

export async function refreshGscSummary(
  siteId: string,
  propertyId: string,
  syncRunId: string,
  coverageStatus: string,
  pool = getDatabase().pool,
) {
  const result = await pool.query(
    `WITH latest AS (SELECT max(metric_date) d FROM gsc_daily_site_metrics WHERE site_id=$1 AND property_id=$2), periods AS (SELECT CASE WHEN metric_date > latest.d-28 THEN 'current' ELSE 'previous' END period, sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position FROM gsc_daily_site_metrics,latest WHERE site_id=$1 AND property_id=$2 AND metric_date > latest.d-56 GROUP BY period), counts AS (SELECT (SELECT count(DISTINCT page) FROM gsc_page_metrics WHERE site_id=$1 AND property_id=$2) pages,(SELECT count(DISTINCT query) FROM gsc_query_metrics WHERE site_id=$1 AND property_id=$2) queries,(SELECT count(*) FROM gsc_daily_site_metrics WHERE site_id=$1 AND property_id=$2)+(SELECT count(*) FROM gsc_query_metrics WHERE site_id=$1 AND property_id=$2)+(SELECT count(*) FROM gsc_page_metrics WHERE site_id=$1 AND property_id=$2)+(SELECT count(*) FROM gsc_query_page_metrics WHERE site_id=$1 AND property_id=$2) rows FROM latest) SELECT latest.d,(SELECT row_to_json(periods) FROM periods WHERE period='current') current,(SELECT row_to_json(periods) FROM periods WHERE period='previous') previous,counts.* FROM latest,counts`,
    [siteId, propertyId],
  );
  const value = result.rows[0];
  const current = value.current ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const previous = value.previous ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const deltas = Object.fromEntries(
    ['clicks', 'impressions', 'ctr', 'position'].map((key) => [
      key,
      Number(current[key] ?? 0) - Number(previous[key] ?? 0),
    ]),
  );
  await pool.query(
    `INSERT INTO gsc_sync_summaries(site_id,property_id,last_sync_run_id,last_finalized_date,current_metrics,previous_metrics,deltas,top_pages_count,top_queries_count,rows_stored,coverage_status,latest_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SUCCEEDED') ON CONFLICT(site_id) DO UPDATE SET property_id=excluded.property_id,last_sync_run_id=excluded.last_sync_run_id,last_finalized_date=excluded.last_finalized_date,current_metrics=excluded.current_metrics,previous_metrics=excluded.previous_metrics,deltas=excluded.deltas,top_pages_count=excluded.top_pages_count,top_queries_count=excluded.top_queries_count,rows_stored=excluded.rows_stored,coverage_status=excluded.coverage_status,latest_status='SUCCEEDED',updated_at=now()`,
    [
      siteId,
      propertyId,
      syncRunId,
      value.d,
      JSON.stringify(current),
      JSON.stringify(previous),
      JSON.stringify(deltas),
      value.pages,
      value.queries,
      value.rows,
      coverageStatus,
    ],
  );
}

export async function refreshGscCrawlMappings(
  siteId: string,
  propertyId: string,
  pool = getDatabase().pool,
) {
  await pool.query('DELETE FROM gsc_page_crawl_mappings WHERE site_id=$1 AND property_id=$2', [
    siteId,
    propertyId,
  ]);
  await pool.query(
    `WITH latest AS (SELECT id FROM crawl_runs WHERE site_id=$1 AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1), pages AS (SELECT cp.* FROM crawl_pages cp JOIN latest ON latest.id=cp.crawl_run_id), candidates AS (SELECT DISTINCT pm.page,(SELECT (array_agg(id))[1] FROM pages WHERE url=pm.page HAVING count(*)=1) exact,(SELECT (array_agg(id))[1] FROM pages WHERE final_url=pm.page HAVING count(*)=1) final,(SELECT (array_agg(id))[1] FROM pages WHERE canonical_url=pm.page HAVING count(*)=1) canonical,(SELECT id FROM latest) run_id FROM gsc_page_metrics pm WHERE pm.site_id=$1 AND pm.property_id=$2) INSERT INTO gsc_page_crawl_mappings(site_id,property_id,gsc_page,crawl_run_id,crawl_page_id,reason) SELECT $1,$2,page,run_id,coalesce(exact,final,canonical),CASE WHEN exact IS NOT NULL THEN 'EXACT_URL' WHEN final IS NOT NULL THEN 'FINAL_URL' ELSE 'CANONICAL_MATCH' END FROM candidates WHERE coalesce(exact,final,canonical) IS NOT NULL`,
    [siteId, propertyId],
  );
}

export async function gscSiteStatus(siteId: string, pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT c.status,p.property_uri,s.last_finalized_date,s.latest_status,s.updated_at AS last_sync_at FROM gsc_connections c LEFT JOIN site_gsc_properties m ON m.connection_id=c.id AND m.site_id=$1 LEFT JOIN gsc_properties p ON p.id=m.property_id LEFT JOIN gsc_sync_summaries s ON s.site_id=$1 WHERE c.site_id=$1 LIMIT 1`,
    [siteId],
  );
  return result.rows[0] ?? null;
}

export async function gscSiteView(
  siteId: string,
  filters: { query?: string; page?: string } = {},
  pool = getDatabase().pool,
) {
  const started = performance.now();
  const [connection, properties, summary, latestJob, runs, queries, pages, queryPages] =
    await Promise.all([
      pool.query(
        `SELECT id,status,disconnected_at,last_error_code FROM gsc_connections WHERE site_id=$1 LIMIT 1`,
        [siteId],
      ),
      pool.query(
        `SELECT p.id,p.property_uri,p.property_type,p.permission_level,p.last_discovered_at,(m.property_id IS NOT NULL) selected FROM gsc_properties p JOIN gsc_connections c ON c.id=p.connection_id LEFT JOIN site_gsc_properties m ON m.property_id=p.id AND m.site_id=$1 WHERE c.site_id=$1 ORDER BY p.property_uri LIMIT 100`,
        [siteId],
      ),
      pool.query(
        `SELECT s.*,p.property_uri FROM gsc_sync_summaries s JOIN gsc_properties p ON p.id=s.property_id WHERE s.site_id=$1`,
        [siteId],
      ),
      pool.query(
        `SELECT status,payload->>'mode' mode,created_at,started_at,finished_at,failure_code,failure_summary FROM jobs WHERE site_id=$1 AND type='GSC_SYNC' ORDER BY created_at DESC LIMIT 1`,
        [siteId],
      ),
      pool.query(
        `SELECT id,mode,status,start_date,end_date,api_requests,rows_received,coverage_status,started_at,finished_at,failure_code FROM gsc_sync_runs WHERE site_id=$1 ORDER BY started_at DESC LIMIT 20`,
        [siteId],
      ),
      pool.query(
        `SELECT query,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position FROM gsc_query_metrics WHERE site_id=$1 AND ($2='' OR query ILIKE '%'||$2||'%') GROUP BY query ORDER BY clicks DESC LIMIT 50`,
        [siteId, filters.query ?? ''],
      ),
      pool.query(
        `SELECT page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position FROM gsc_page_metrics WHERE site_id=$1 AND ($2='' OR page ILIKE '%'||$2||'%') GROUP BY page ORDER BY clicks DESC LIMIT 50`,
        [siteId, filters.page ?? ''],
      ),
      pool.query(
        `SELECT metric_date,query,page,clicks,impressions,ctr,position FROM gsc_query_page_metrics WHERE site_id=$1 AND ($2='' OR query ILIKE '%'||$2||'%') AND ($3='' OR page ILIKE '%'||$3||'%') ORDER BY metric_date DESC,clicks DESC LIMIT 50`,
        [siteId, filters.query ?? '', filters.page ?? ''],
      ),
    ]);
  return {
    connection: connection.rows[0] ?? null,
    properties: properties.rows,
    summary: summary.rows[0] ?? null,
    latestJob: latestJob.rows[0] ?? null,
    runs: runs.rows,
    queries: queries.rows,
    pages: pages.rows,
    queryPages: queryPages.rows,
    timingMs: performance.now() - started,
  };
}
