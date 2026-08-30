import {
  createProductionSchedulerRuntime,
  getDatabase,
  pollProductionScheduler,
  recordSchedulerFailure,
  recordWorkerHeartbeat,
} from '@seo-agent/database';
import { envSchema } from '@seo-agent/shared';
import { resourceGuardFromEnv } from '@seo-agent/resource-guard';
import { executeOne, recover } from './runner.js';

const env = envSchema.parse(process.env);
const { db, pool } = getDatabase();
const schedulerRuntime = createProductionSchedulerRuntime(new Date(), env.SCHEDULER_DAILY_AT);
const heartbeatGuard = resourceGuardFromEnv();
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

await recover(db, env.STALE_JOB_MINUTES);
console.log(`Worker ${env.WORKER_ID} started (heavy concurrency: 1).`);
let nextHeartbeat = 0;
let nextSchedulerPoll = 0;
while (!stopping) {
  if (Date.now() >= nextHeartbeat) {
    const resource = await heartbeatGuard.evaluate();
    await recordWorkerHeartbeat(
      env.WORKER_ID,
      {
        gitSha: env.APP_GIT_SHA,
        schedulerEnabled: env.SCHEDULER_ENABLED,
        schedulerDailyAt: schedulerRuntime.dailyAt,
        schedulerTimezone: 'Asia/Bangkok',
        executor: {
          status: resource.allowed ? 'READY' : `BLOCKED_${resource.reasons.join('_')}`,
          reasons: resource.reasons,
          snapshot: resource.snapshot,
        },
      },
      db,
    );
    nextHeartbeat = Date.now() + 30_000;
  }
  if (env.SCHEDULER_ENABLED && Date.now() >= nextSchedulerPoll) {
    const checkedAt = new Date();
    try {
      await pollProductionScheduler(
        schedulerRuntime,
        { enabled: env.SCHEDULER_ENABLED, now: checkedAt },
        pool,
      );
    } catch {
      await recordSchedulerFailure(checkedAt, pool);
      console.error('Daily opportunity scheduler failed.');
    }
    nextSchedulerPoll = Date.now() + env.SCHEDULER_POLL_MS;
  }
  const outcome = await executeOne(env.WORKER_ID, pool);
  if (outcome.state === 'IDLE' || outcome.state === 'RESOURCE_DENIED')
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_MS));
}
await pool.end();
