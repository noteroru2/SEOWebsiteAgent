import { getDatabase, recordWorkerHeartbeat } from '@seo-agent/database';
import { envSchema } from '@seo-agent/shared';
import { executeOne, recover } from './runner.js';

const env = envSchema.parse(process.env);
const { db, pool } = getDatabase();
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
while (!stopping) {
  if (Date.now() >= nextHeartbeat) {
    await recordWorkerHeartbeat(env.WORKER_ID, db);
    nextHeartbeat = Date.now() + 30_000;
  }
  const outcome = await executeOne(env.WORKER_ID, pool);
  if (outcome.state === 'IDLE' || outcome.state === 'RESOURCE_DENIED')
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_MS));
}
await pool.end();
