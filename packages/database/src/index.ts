import { and, asc, count, desc, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { createSiteSchema, enqueueJobSchema, type JobType } from '@seo-agent/shared';
import * as schema from './schema';

export * from './schema';
export type Database = ReturnType<typeof drizzle<typeof schema>>;
let singleton: { pool: Pool; db: Database } | undefined;

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  return { pool, db: drizzle(pool, { schema }) };
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
    .select()
    .from(schema.sites)
    .orderBy(asc(schema.sites.name))
    .limit(100);
  return { rows, timingMs: performance.now() - started };
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
export const registeredJobTypes: ReadonlySet<JobType> = new Set(['SYSTEM_TEST']);
