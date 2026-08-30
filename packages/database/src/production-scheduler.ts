import type { Pool } from 'pg';
import { getDatabase } from './index';

export const PRODUCTION_TIMEZONE = 'Asia/Bangkok';
export const DEFAULT_SCHEDULER_DAILY_AT = '09:15';

export type SchedulerEligibility =
  'DISABLED' | 'WAITING_FOR_SCHEDULE' | 'SKIPPED_LATE_START' | 'ELIGIBLE';

export type ProductionSchedulerRuntime = {
  startupBangkokDate: string;
  skippedBangkokDate: string | null;
  dailyAt: string;
  dailyMinuteOfDay: number;
};

export function resolveProductionSchedulerDailyAt(value?: string) {
  const dailyAt = value ?? DEFAULT_SCHEDULER_DAILY_AT;
  const match = /^(?:([01]\d)|(2[0-3])):([0-5]\d)$/.exec(dailyAt);
  if (!match) throw new Error('SCHEDULER_DAILY_AT must use 24-hour HH:MM.');
  const hour = Number(match[1] ?? match[2]);
  const minute = Number(match[3]);
  return { dailyAt, minuteOfDay: hour * 60 + minute };
}

const bangkokClockFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRODUCTION_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function bangkokClock(now: Date) {
  const parts = Object.fromEntries(
    bangkokClockFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(minuteOfDay))
    throw new Error('Unable to resolve the scheduler clock in Asia/Bangkok.');
  return { date, minuteOfDay };
}

export function createProductionSchedulerRuntime(
  startedAt: Date = new Date(),
  configuredDailyAt?: string,
) {
  const startupClock = bangkokClock(startedAt);
  const schedule = resolveProductionSchedulerDailyAt(configuredDailyAt);
  return {
    startupBangkokDate: startupClock.date,
    skippedBangkokDate: startupClock.minuteOfDay >= schedule.minuteOfDay ? startupClock.date : null,
    dailyAt: schedule.dailyAt,
    dailyMinuteOfDay: schedule.minuteOfDay,
  } satisfies ProductionSchedulerRuntime;
}

export function productionSchedulerEligibility(
  runtime: ProductionSchedulerRuntime,
  now: Date = new Date(),
): Exclude<SchedulerEligibility, 'DISABLED'> {
  const clock = bangkokClock(now);
  if (runtime.skippedBangkokDate === clock.date) return 'SKIPPED_LATE_START';
  if (clock.minuteOfDay < runtime.dailyMinuteOfDay) return 'WAITING_FOR_SCHEDULE';
  return 'ELIGIBLE';
}

async function recordSchedulerTick(
  now: Date,
  eligibility: Exclude<SchedulerEligibility, 'DISABLED' | 'ELIGIBLE'>,
  runtime: ProductionSchedulerRuntime,
  pool: Pool,
) {
  await pool.query(
    `INSERT INTO system_events(source, level, event, detail)
     VALUES('scheduler', 'INFO', 'SCHEDULER_TICK', $1::jsonb)`,
    [
      JSON.stringify({
        checkedAt: now.toISOString(),
        timezone: PRODUCTION_TIMEZONE,
        dailyAt: runtime.dailyAt,
        eligibility,
        startupBangkokDate: runtime.startupBangkokDate,
        skippedBangkokDate: runtime.skippedBangkokDate,
        due: 0,
        enqueued: 0,
      }),
    ],
  );
}

export async function pollProductionScheduler(
  runtime: ProductionSchedulerRuntime,
  options: { enabled: boolean; now?: Date },
  pool: Pool = getDatabase().pool,
) {
  if (!options.enabled)
    return {
      eligibility: 'DISABLED' as const,
      acquired: false,
      due: 0,
      enqueued: 0,
      jobIds: [] as string[],
      heartbeatRecorded: false,
    };

  const now = options.now ?? new Date();
  const eligibility = productionSchedulerEligibility(runtime, now);
  if (eligibility !== 'ELIGIBLE') {
    await recordSchedulerTick(now, eligibility, runtime, pool);
    return {
      eligibility,
      acquired: false,
      due: 0,
      enqueued: 0,
      jobIds: [] as string[],
      heartbeatRecorded: true,
    };
  }

  const result = await enqueueDueOpportunityWatches(now, pool, runtime.dailyAt);
  return {
    ...result,
    eligibility,
    heartbeatRecorded: result.acquired,
  };
}

export async function enqueueDueOpportunityWatches(
  now: Date = new Date(),
  pool: Pool = getDatabase().pool,
  configuredDailyAt?: string,
) {
  const schedule = resolveProductionSchedulerDailyAt(configuredDailyAt);
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
         AND clock.local_now >= clock.local_date + $3::time
           + make_interval(mins => COALESCE(s.stagger_minute, 0))
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.site_id = s.id AND j.type = 'PRODUCTION_OPPORTUNITY_WATCH'
             AND j.status <> 'CANCELLED'
             AND COALESCE(j.payload->>'scheduleDate', (j.created_at AT TIME ZONE $2)::date::text)
               = clock.local_date::text
         )
         AND NOT EXISTS (
           SELECT 1 FROM opportunity_watch_runs r
           WHERE r.site_id = s.id
             AND (r.created_at AT TIME ZONE $2)::date = clock.local_date
         )
       ORDER BY s.stagger_minute, s.id`,
      [now.toISOString(), PRODUCTION_TIMEZONE, schedule.dailyAt],
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
            dailyAt: schedule.dailyAt,
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
          dailyAt: schedule.dailyAt,
          eligibility: 'ELIGIBLE',
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
    schedulerDailyAt?: string;
    expectedMigrationCount?: number;
    staleJobMinutes?: number;
    now?: Date;
  } = {},
  pool: Pool = getDatabase().pool,
) {
  const now = options.now ?? new Date();
  const schedulerEnabled = options.schedulerEnabled ?? process.env.SCHEDULER_ENABLED === 'true';
  const schedulerDailyAt = resolveProductionSchedulerDailyAt(
    options.schedulerDailyAt ?? process.env.SCHEDULER_DAILY_AT,
  );
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
       (SELECT created_at FROM system_events WHERE source = 'worker' AND event = 'HEARTBEAT' ORDER BY created_at DESC LIMIT 1) AS worker_heartbeat,
       (SELECT detail FROM system_events WHERE source = 'worker' AND event = 'HEARTBEAT' ORDER BY created_at DESC LIMIT 1) AS worker_detail,
       (SELECT created_at FROM system_events WHERE source = 'scheduler' AND event = 'SCHEDULER_TICK' ORDER BY created_at DESC LIMIT 1) AS scheduler_heartbeat,
       (SELECT detail FROM system_events WHERE source = 'scheduler' AND event = 'SCHEDULER_TICK' ORDER BY created_at DESC LIMIT 1) AS scheduler_detail,
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
  const workerDetail = (row.worker_detail ?? {}) as Record<string, unknown>;
  const schedulerDetail = (row.scheduler_detail ?? {}) as Record<string, unknown>;
  const workerHeartbeat = row.worker_heartbeat ? new Date(row.worker_heartbeat) : null;
  const schedulerHeartbeat = row.scheduler_heartbeat ? new Date(row.scheduler_heartbeat) : null;
  const workerHealthy = Boolean(
    workerHeartbeat && now.getTime() - workerHeartbeat.getTime() <= 90_000,
  );
  const runtimeSchedulerEnabled =
    typeof workerDetail.schedulerEnabled === 'boolean'
      ? workerDetail.schedulerEnabled
      : schedulerEnabled;
  const runtimeSchedulerDailyAt =
    typeof workerDetail.schedulerDailyAt === 'string'
      ? resolveProductionSchedulerDailyAt(workerDetail.schedulerDailyAt)
      : typeof schedulerDetail.dailyAt === 'string'
        ? resolveProductionSchedulerDailyAt(schedulerDetail.dailyAt)
        : schedulerDailyAt;
  const schedulerHealthy =
    !runtimeSchedulerEnabled ||
    Boolean(schedulerHeartbeat && now.getTime() - schedulerHeartbeat.getTime() <= 180_000);
  const migrationCount = Number(row.migration_count ?? 0);
  const migrationHealthy =
    Number.isInteger(expectedMigrationCount) && migrationCount === expectedMigrationCount;
  const webGitSha = process.env.APP_GIT_SHA?.trim() || 'unknown';
  const workerGitSha = String(workerDetail.gitSha ?? webGitSha);
  const versionConfigured =
    /^[a-f0-9]{40}$/i.test(webGitSha) && /^[a-f0-9]{40}$/i.test(workerGitSha);
  const staleRunning = Number(row.stale_running ?? 0);
  const queueHealthy = staleRunning === 0;
  const executor = (workerDetail.executor ?? {}) as Record<string, unknown>;
  const executorReady = workerHealthy && executor.status === 'READY';

  return {
    status:
      workerHealthy && schedulerHealthy && queueHealthy && migrationHealthy && versionConfigured
        ? 'HEALTHY'
        : 'DEGRADED',
    gitSha: webGitSha,
    versionConfigured,
    worker: {
      healthy: workerHealthy,
      heartbeat: workerHeartbeat,
      gitSha: workerGitSha,
      state: workerHealthy ? 'RUNNING' : workerHeartbeat ? 'STALE' : 'STOPPED',
    },
    executor: {
      ready: executorReady,
      status: executorReady ? 'READY' : String(executor.status ?? 'UNKNOWN'),
      reasons: Array.isArray(executor.reasons) ? executor.reasons.map(String) : [],
      snapshot: executor.snapshot ?? null,
    },
    scheduler: {
      enabled: runtimeSchedulerEnabled,
      required: runtimeSchedulerEnabled,
      healthy: schedulerHealthy,
      heartbeat: schedulerHeartbeat,
      timezone: String(
        workerDetail.schedulerTimezone ?? schedulerDetail.timezone ?? PRODUCTION_TIMEZONE,
      ),
      dailyAt: runtimeSchedulerDailyAt.dailyAt,
      lastEligibility: schedulerDetail.eligibility ? String(schedulerDetail.eligibility) : null,
      lastDue: Number(schedulerDetail.due ?? 0),
      lastEnqueued: Number(schedulerDetail.enqueued ?? 0),
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
    runtime: {
      webGitSha,
      workerGitSha,
      mixed: webGitSha !== 'unknown' && workerGitSha !== 'unknown' && webGitSha !== workerGitSha,
    },
    checkedAt: now,
  };
}
