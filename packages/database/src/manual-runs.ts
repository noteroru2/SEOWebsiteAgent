import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDatabase } from './index';
import { PRODUCTION_TIMEZONE } from './production-scheduler';

export type ManualRunMode = 'ALL' | 'SITE';
export type ManualRunSkip = { siteId: string; siteName: string; reason: string };

const bangkokDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRODUCTION_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function bangkokDate(now: Date) {
  return bangkokDateFormatter.format(now);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function latestRuntimeEvents(client: PoolClient | Pool) {
  return client.query(
    `SELECT DISTINCT ON (source) source, created_at, detail
     FROM system_events
     WHERE (source='worker' AND event='HEARTBEAT')
        OR (lower(source)='scheduler' AND event='SCHEDULER_TICK')
     ORDER BY source, created_at DESC`,
  );
}

export async function manualCommandSnapshot(
  now: Date = new Date(),
  pool: Pool = getDatabase().pool,
) {
  const [runtime, queue, recent, activity] = await Promise.all([
    latestRuntimeEvents(pool),
    pool.query(
      `SELECT
         count(*) FILTER (WHERE status='QUEUED')::int queued,
         count(*) FILTER (WHERE status='RUNNING')::int running,
         count(*) FILTER (WHERE status='SUCCEEDED' AND finished_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)::int succeeded_today,
         count(*) FILTER (WHERE status='FAILED' AND finished_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)::int failed_today,
         max(started_at) last_claim_at,
         max(finished_at) FILTER (WHERE status IN ('SUCCEEDED','FAILED','CANCELLED')) last_completion_at
       FROM jobs`,
      [PRODUCTION_TIMEZONE],
    ),
    pool.query(
      `SELECT detail, created_at
       FROM system_events
       WHERE source='owner_ui' AND event='MANUAL_RUN_REQUESTED'
       ORDER BY created_at DESC LIMIT 10`,
    ),
    pool.query(
      `SELECT count(*)::int eligible
       FROM sites s
       WHERE s.active=true
         AND s.watch_mode IN ('MONITOR_ONLY','ANALYSIS_ENABLED','CHANGE_ENABLED')
         AND s.source_status='CURRENT'
         AND EXISTS (
           SELECT 1 FROM site_repositories r
           WHERE r.site_id=s.id AND r.enabled=true AND r.worktree_clean=true
             AND r.head_sha IS NOT NULL
         )`,
    ),
  ]);
  const workerRow = runtime.rows.find((row) => row.source === 'worker');
  const schedulerRow = runtime.rows.find((row) => String(row.source).toLowerCase() === 'scheduler');
  const workerHeartbeat = workerRow?.created_at ? new Date(workerRow.created_at) : null;
  const workerFresh = Boolean(
    workerHeartbeat && now.getTime() - workerHeartbeat.getTime() <= 90_000,
  );
  const workerDetail = asRecord(workerRow?.detail);
  const schedulerDetail = asRecord(schedulerRow?.detail);
  const executor = asRecord(workerDetail.executor);
  const executorReady = workerFresh && executor.status === 'READY';
  const queueRow = queue.rows[0] ?? {};
  const webSha = process.env.APP_GIT_SHA?.trim() || 'unknown';
  const workerSha = String(workerDetail.gitSha ?? 'unknown');

  return {
    checkedAt: now,
    worker: {
      state: workerFresh ? 'RUNNING' : workerHeartbeat ? 'STALE' : 'STOPPED',
      healthy: workerFresh,
      heartbeat: workerHeartbeat,
      gitSha: workerSha,
    },
    executor: {
      status: executorReady ? 'READY' : String(executor.status ?? 'UNKNOWN'),
      ready: executorReady,
      reasons: Array.isArray(executor.reasons) ? executor.reasons.map(String) : [],
      snapshot: executor.snapshot ?? null,
    },
    scheduler: {
      enabled: workerDetail.schedulerEnabled === true,
      dailyAt: String(workerDetail.schedulerDailyAt ?? schedulerDetail.dailyAt ?? 'unknown'),
      timezone: String(
        workerDetail.schedulerTimezone ?? schedulerDetail.timezone ?? PRODUCTION_TIMEZONE,
      ),
      heartbeat: schedulerRow?.created_at ? new Date(schedulerRow.created_at) : null,
      lastEligibility: schedulerDetail.eligibility ? String(schedulerDetail.eligibility) : null,
      lastDue: Number(schedulerDetail.due ?? 0),
      lastEnqueued: Number(schedulerDetail.enqueued ?? 0),
    },
    queue: {
      queued: Number(queueRow.queued ?? 0),
      running: Number(queueRow.running ?? 0),
      succeededToday: Number(queueRow.succeeded_today ?? 0),
      failedToday: Number(queueRow.failed_today ?? 0),
      lastClaimAt: queueRow.last_claim_at ? new Date(queueRow.last_claim_at) : null,
      lastCompletionAt: queueRow.last_completion_at ? new Date(queueRow.last_completion_at) : null,
    },
    runtime: {
      webSha,
      workerSha,
      mixed: webSha !== 'unknown' && workerSha !== 'unknown' && webSha !== workerSha,
    },
    eligibleSites: Number(activity.rows[0]?.eligible ?? 0),
    recentCommands: recent.rows.map((row) => ({
      ...(row.detail as Record<string, unknown>),
      requestedAt: row.created_at,
    })),
  };
}

function skipReason(site: {
  active: boolean;
  watch_mode: string;
  source_status: string;
  repository_id?: string | null;
  repository_enabled?: boolean | null;
  worktree_clean?: boolean | null;
  head_sha?: string | null;
}) {
  if (!site.active) return 'SITE_INACTIVE';
  if (!['MONITOR_ONLY', 'ANALYSIS_ENABLED', 'CHANGE_ENABLED'].includes(site.watch_mode))
    return 'WATCH_MODE_INELIGIBLE';
  if (site.source_status !== 'CURRENT') return 'SOURCE_NOT_CURRENT';
  if (!site.repository_id) return 'SOURCE_NOT_CONFIGURED';
  if (!site.repository_enabled) return 'SOURCE_DISABLED';
  if (!site.worktree_clean) return 'SOURCE_WORKTREE_NOT_CLEAN';
  if (!site.head_sha) return 'SOURCE_HEAD_UNKNOWN';
  return null;
}

export async function enqueueManualOpportunityWatch(
  input: { mode: ManualRunMode; siteId?: string; requestedAt?: Date },
  pool: Pool = getDatabase().pool,
) {
  const requestedAt = input.requestedAt ?? new Date();
  const commandRunId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('seo-agent:daily-watch-scheduler'))`);
    const sites = await client.query(
      `SELECT s.id, s.name, s.active, s.watch_mode, s.source_status,
              r.id repository_id, r.enabled repository_enabled,
              r.worktree_clean, r.head_sha
       FROM sites s
       LEFT JOIN LATERAL (
         SELECT * FROM site_repositories sr
         WHERE sr.site_id=s.id ORDER BY sr.created_at DESC LIMIT 1
       ) r ON true
       WHERE ($1::uuid IS NULL OR s.id=$1)
       ORDER BY s.name
       FOR UPDATE OF s`,
      [input.mode === 'SITE' ? input.siteId : null],
    );
    if (input.mode === 'SITE' && sites.rowCount === 0) {
      const error = Object.assign(new Error('Site not found'), { code: 'SITE_NOT_FOUND' });
      throw error;
    }

    const result = {
      runId: commandRunId,
      source: 'MANUAL_OWNER' as const,
      requested: sites.rowCount ?? 0,
      eligible: 0,
      enqueued: 0,
      alreadyQueued: 0,
      alreadyRunning: 0,
      alreadyCompletedToday: 0,
      skipped: [] as ManualRunSkip[],
      jobIds: [] as string[],
    };
    await client.query(
      `INSERT INTO system_events(source,level,event,detail)
       VALUES('owner_ui','INFO','MANUAL_RUN_REQUESTED',$1::jsonb)`,
      [
        JSON.stringify({
          commandRunId,
          commandSource: 'MANUAL_OWNER',
          mode: input.mode,
          siteId: input.siteId ?? null,
          requestedAt: requestedAt.toISOString(),
          requested: result.requested,
        }),
      ],
    );

    for (const site of sites.rows) {
      const reason = skipReason(site);
      if (reason) {
        result.skipped.push({ siteId: site.id, siteName: site.name, reason });
        continue;
      }
      result.eligible += 1;
      const completedToday = await client.query(
        `SELECT id FROM jobs
         WHERE site_id=$1 AND type='PRODUCTION_OPPORTUNITY_WATCH'
           AND status='SUCCEEDED'
           AND COALESCE(payload->>'scheduleDate',
             to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD'))=$3
         ORDER BY created_at DESC LIMIT 1`,
        [site.id, PRODUCTION_TIMEZONE, bangkokDate(requestedAt)],
      );
      if (completedToday.rows[0]) {
        result.alreadyCompletedToday += 1;
        result.skipped.push({
          siteId: site.id,
          siteName: site.name,
          reason: 'ALREADY_COMPLETED_TODAY',
        });
        continue;
      }
      const active = await client.query(
        `SELECT id,status FROM jobs
         WHERE site_id=$1 AND type='PRODUCTION_OPPORTUNITY_WATCH'
           AND status IN ('QUEUED','RUNNING')
         ORDER BY created_at DESC LIMIT 1`,
        [site.id],
      );
      if (active.rows[0]) {
        if (active.rows[0].status === 'QUEUED') result.alreadyQueued += 1;
        else result.alreadyRunning += 1;
        result.skipped.push({
          siteId: site.id,
          siteName: site.name,
          reason: active.rows[0].status === 'QUEUED' ? 'ALREADY_QUEUED' : 'ALREADY_RUNNING',
        });
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO jobs(site_id,type,status,heavy,payload,max_attempts)
         VALUES($1,'PRODUCTION_OPPORTUNITY_WATCH','QUEUED',false,$2::jsonb,1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          site.id,
          JSON.stringify({
            commandRunId,
            commandSource: 'MANUAL_OWNER',
            requestedAt: requestedAt.toISOString(),
            scheduleDate: bangkokDate(requestedAt),
            timezone: PRODUCTION_TIMEZONE,
          }),
        ],
      );
      const jobId = inserted.rows[0]?.id as string | undefined;
      if (!jobId) {
        const raced = await client.query(
          `SELECT status FROM jobs WHERE site_id=$1 AND type='PRODUCTION_OPPORTUNITY_WATCH'
             AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1`,
          [site.id],
        );
        if (raced.rows[0]?.status === 'RUNNING') result.alreadyRunning += 1;
        else result.alreadyQueued += 1;
        result.skipped.push({ siteId: site.id, siteName: site.name, reason: 'ACTIVE_JOB_RACE' });
        continue;
      }
      result.jobIds.push(jobId);
      result.enqueued += 1;
      await client.query(
        `INSERT INTO job_events(job_id,event,detail)
         VALUES($1,'ENQUEUED',$2::jsonb),($1,'MANUAL_RUN_ENQUEUED',$2::jsonb)`,
        [jobId, JSON.stringify({ commandRunId, commandSource: 'MANUAL_OWNER', siteId: site.id })],
      );
    }
    await client.query(
      `INSERT INTO system_events(source,level,event,detail)
       VALUES('owner_ui','INFO','MANUAL_RUN_ENQUEUED',$1::jsonb)`,
      [JSON.stringify({ ...result, commandRunId, skipped: result.skipped })],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function manualRunStatus(runId: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT j.id,j.site_id,s.name site_name,j.status,j.created_at,j.started_at,j.finished_at,
            j.failure_code,j.failure_summary,j.result
     FROM jobs j JOIN sites s ON s.id=j.site_id
     WHERE j.type='PRODUCTION_OPPORTUNITY_WATCH'
       AND j.payload->>'commandRunId'=$1
     ORDER BY j.created_at`,
    [runId],
  );
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of result.rows) {
    if (row.status === 'QUEUED') counts.queued += 1;
    else if (row.status === 'RUNNING') counts.running += 1;
    else if (row.status === 'SUCCEEDED') counts.completed += 1;
    else if (row.status === 'FAILED') counts.failed += 1;
    else if (row.status === 'CANCELLED') counts.cancelled += 1;
  }
  return { runId, counts, jobs: result.rows, lastUpdate: new Date() };
}
