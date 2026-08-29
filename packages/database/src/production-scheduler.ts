import type { Pool } from 'pg';
import { getDatabase } from './index';

export const PRODUCTION_TIMEZONE = 'Asia/Bangkok';
export const DAILY_WATCH_HOUR = 9;
export const DAILY_WATCH_MINUTE = 15;

export async function enqueueDueOpportunityWatches(
  now: Date = new Date(),
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext('seo-agent:daily-watch-scheduler')) AS acquired`,
    );
    if (!lock.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      return { acquired: false, due: 0, enqueued: 0, jobIds: [] as string[] };
    }

    const due = await client.query(
      `WITH clock AS (
         SELECT ($1::timestamptz AT TIME ZONE $2) AS local_now,
                ($1::timestamptz AT TIME ZONE $2)::date AS local_date
       )
       SELECT s.id, clock.local_date::text AS local_date
       FROM sites s CROSS JOIN clock
       WHERE s.active = true
         AND s.watch_mode IN ('MONITOR_ONLY', 'ANALYSIS_ENABLED', 'CHANGE_ENABLED')
         AND clock.local_now >= clock.local_date + time '09:15'
           + make_interval(mins => COALESCE(s.stagger_minute, 0))
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.site_id = s.id AND j.type = 'PRODUCTION_OPPORTUNITY_WATCH'
             AND (j.created_at AT TIME ZONE $2)::date = clock.local_date
         )
         AND NOT EXISTS (
           SELECT 1 FROM opportunity_watch_runs r
           WHERE r.site_id = s.id
             AND (r.created_at AT TIME ZONE $2)::date = clock.local_date
         )
       ORDER BY s.stagger_minute, s.id`,
      [now.toISOString(), PRODUCTION_TIMEZONE],
    );

    const jobIds: string[] = [];
    for (const site of due.rows) {
      const inserted = await client.query(
        `INSERT INTO jobs(site_id, type, status, heavy, payload, max_attempts)
         VALUES($1, 'PRODUCTION_OPPORTUNITY_WATCH', 'QUEUED', false, $2::jsonb, 1)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          site.id,
          JSON.stringify({
            scheduleDate: site.local_date,
            scheduleSource: 'DAILY_SCHEDULER',
            timezone: PRODUCTION_TIMEZONE,
          }),
        ],
      );
      const jobId = inserted.rows[0]?.id as string | undefined;
      if (!jobId) continue;
      jobIds.push(jobId);
      await client.query(
        `INSERT INTO job_events(job_id, event, detail)
         VALUES($1, 'ENQUEUED', $2::jsonb)`,
        [jobId, JSON.stringify({ source: 'DAILY_SCHEDULER', localDate: site.local_date })],
      );
    }

    await client.query(
      `INSERT INTO system_events(source, level, event, detail)
       VALUES('scheduler', 'INFO', 'SCHEDULER_TICK', $1::jsonb)`,
      [
        JSON.stringify({
          checkedAt: now.toISOString(),
          timezone: PRODUCTION_TIMEZONE,
          due: due.rowCount ?? 0,
          enqueued: jobIds.length,
        }),
      ],
    );
    await client.query('COMMIT');
    return { acquired: true, due: due.rowCount ?? 0, enqueued: jobIds.length, jobIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordSchedulerFailure(
  now: Date = new Date(),
  pool: Pool = getDatabase().pool,
) {
  await pool.query(
    `INSERT INTO system_events(source, level, event, detail)
     VALUES('scheduler', 'ERROR', 'SCHEDULER_FAILED', $1::jsonb)`,
    [JSON.stringify({ checkedAt: now.toISOString() })],
  );
}

export async function productionHealthSnapshot(
  options: {
    schedulerEnabled?: boolean;
    expectedMigrationCount?: number;
    staleJobMinutes?: number;
    now?: Date;
  } = {},
  pool: Pool = getDatabase().pool,
) {
  const now = options.now ?? new Date();
  const schedulerEnabled = options.schedulerEnabled ?? process.env.SCHEDULER_ENABLED === 'true';
  const expectedMigrationCount =
    options.expectedMigrationCount ?? Number(process.env.EXPECTED_MIGRATION_COUNT ?? 24);
  const configuredStaleJobMinutes =
    options.staleJobMinutes ?? Number(process.env.STALE_JOB_MINUTES ?? 15);
  const staleJobMinutes =
    Number.isFinite(configuredStaleJobMinutes) && configuredStaleJobMinutes > 0
      ? configuredStaleJobMinutes
      : 15;
  const result = await pool.query(
    `SELECT
       (SELECT max(created_at) FROM system_events WHERE source = 'worker' AND event = 'HEARTBEAT') AS worker_heartbeat,
       (SELECT max(created_at) FROM system_events WHERE source = 'scheduler' AND event = 'SCHEDULER_TICK') AS scheduler_heartbeat,
       (SELECT max(created_at) FROM opportunity_watch_runs) AS latest_watch_run,
       (SELECT count(*)::int FROM jobs WHERE status = 'QUEUED') AS queued,
       (SELECT count(*)::int FROM jobs WHERE status = 'RUNNING') AS running,
       (SELECT count(*)::int FROM jobs
        WHERE status = 'RUNNING'
          AND COALESCE(heartbeat_at, started_at, updated_at)
            < $1::timestamptz - make_interval(mins => $2)) AS stale_running,
       (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migration_count`,
    [now.toISOString(), staleJobMinutes],
  );
  const row = result.rows[0] ?? {};
  const workerHeartbeat = row.worker_heartbeat ? new Date(row.worker_heartbeat) : null;
  const schedulerHeartbeat = row.scheduler_heartbeat ? new Date(row.scheduler_heartbeat) : null;
  const workerHealthy = Boolean(
    workerHeartbeat && now.getTime() - workerHeartbeat.getTime() <= 90_000,
  );
  const schedulerHealthy =
    !schedulerEnabled ||
    Boolean(schedulerHeartbeat && now.getTime() - schedulerHeartbeat.getTime() <= 180_000);
  const migrationCount = Number(row.migration_count ?? 0);
  const migrationHealthy =
    Number.isInteger(expectedMigrationCount) && migrationCount === expectedMigrationCount;
  const gitSha = process.env.APP_GIT_SHA?.trim() || 'unknown';
  const versionConfigured = /^[a-f0-9]{40}$/i.test(gitSha);
  const staleRunning = Number(row.stale_running ?? 0);
  const queueHealthy = staleRunning === 0;

  return {
    status:
      workerHealthy && schedulerHealthy && queueHealthy && migrationHealthy && versionConfigured
        ? 'HEALTHY'
        : 'DEGRADED',
    gitSha,
    versionConfigured,
    worker: { healthy: workerHealthy, heartbeat: workerHeartbeat },
    scheduler: {
      enabled: schedulerEnabled,
      required: schedulerEnabled,
      healthy: schedulerHealthy,
      heartbeat: schedulerHeartbeat,
      timezone: PRODUCTION_TIMEZONE,
      dailyAt: '09:15',
    },
    queue: {
      healthy: queueHealthy,
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      staleRunning,
    },
    migrations: {
      healthy: migrationHealthy,
      applied: migrationCount,
      expected: expectedMigrationCount,
    },
    latestWatchRun: row.latest_watch_run ? new Date(row.latest_watch_run) : null,
    checkedAt: now,
  };
}
