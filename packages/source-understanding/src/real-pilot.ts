import { enqueueJob, getDatabase } from '@seo-agent/database';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../../../apps/worker/src/runner';

const ids = process.argv.slice(2);
if (ids.length !== 3) throw new Error('Exactly three opportunity ids are required');
const { pool, db } = getDatabase();
const guard = new ResourceGuard(
  {},
  {
    collect: async () => ({
      freeMemoryMb: 2000,
      freeDiskMb: 10_000,
      loadPerCpu: 0,
      platform: 'win32',
    }),
  },
);
try {
  const active = await pool.query(
    `SELECT count(*)::int count FROM jobs WHERE status IN ('QUEUED','RUNNING')`,
  );
  if (active.rows[0].count) throw new Error('Job queue must be idle before the controlled pilot');
  const existing = await pool.query(
    `SELECT count(*)::int count FROM ai_usage WHERE source_plan_run_id IS NOT NULL`,
  );
  if (existing.rows[0].count)
    throw new Error('Source-plan provider usage must be zero before the first pilot');
  const results = [];
  for (const opportunityId of ids) {
    const opportunity = (
      await pool.query(`SELECT site_id,query FROM opportunities WHERE id=$1 AND status='OPEN'`, [
        opportunityId,
      ])
    ).rows[0];
    if (!opportunity) throw new Error('Pilot opportunity is missing or ineligible');
    const job = await enqueueJob(
      { type: 'GENERATE_SOURCE_CHANGE_PLAN', siteId: opportunity.site_id, opportunityId },
      db,
    );
    const outcome = await executeOne('source-real-pilot', pool, guard);
    const persisted = (
      await pool.query(`SELECT result,status,failure_code,failure_summary FROM jobs WHERE id=$1`, [
        job.id,
      ])
    ).rows[0];
    results.push({
      opportunityId,
      query: opportunity.query,
      jobId: job.id,
      outcome: outcome.state,
      status: persisted.status,
      result: persisted.result,
      failureCode: persisted.failure_code,
      failureSummary: persisted.failure_summary,
    });
    if (outcome.state !== 'SUCCEEDED') break;
  }
  process.stdout.write(JSON.stringify(results, null, 2));
} finally {
  await pool.end();
}
