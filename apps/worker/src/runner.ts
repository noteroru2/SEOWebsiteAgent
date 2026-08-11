import {
  claimNextJob,
  markJobFailed,
  markJobSucceeded,
  recoverStaleJobs,
  registeredJobTypes,
  type Database,
} from '@seo-agent/database';
import { resourceGuardFromEnv, type ResourceGuard } from '@seo-agent/resource-guard';
import type { Pool } from 'pg';

export async function executeOne(
  workerId: string,
  pool: Pool,
  guard: ResourceGuard = resourceGuardFromEnv(),
) {
  const resource = await guard.evaluate();
  if (!resource.allowed) return { state: 'RESOURCE_DENIED' as const, resource };
  const job = await claimNextJob(workerId, pool);
  if (!job) return { state: 'IDLE' as const };
  const id = String(job.id);
  try {
    const type = String(job.type);
    if (!registeredJobTypes.has(type as 'SYSTEM_TEST'))
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
