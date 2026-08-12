import {
  getDatabase,
  listSourceApprovals,
  siteSourceSummary,
  sourcePanelForOpportunity,
} from '@seo-agent/database';

const [siteId, opportunityId] = process.argv.slice(2);
if (!siteId || !opportunityId) throw new Error('site and opportunity ids required');
const { pool } = getDatabase();
async function time<T>(operation: () => Promise<T>) {
  const started = performance.now();
  const value = await operation();
  return { ms: Math.round((performance.now() - started) * 10) / 10, value };
}
try {
  const site = await time(() => siteSourceSummary(siteId, pool));
  const opportunity = await time(() => sourcePanelForOpportunity(opportunityId, pool));
  const approvals = await time(() => listSourceApprovals(pool));
  const detail = await time(() =>
    pool.query(
      `SELECT p.*,r.source_context FROM source_change_plans p JOIN source_plan_runs r ON r.id=p.run_id WHERE p.opportunity_id=$1 ORDER BY p.created_at DESC LIMIT 1`,
      [opportunityId],
    ),
  );
  process.stdout.write(
    JSON.stringify({
      siteSourceMs: site.ms,
      opportunitySourceMs: opportunity.ms,
      planDetailMs: detail.ms,
      approvalsMs: approvals.ms,
      siteRoutes: site.value?.routes_mapped,
      opportunityMapping: opportunity.value.mapping?.mapping_status,
      approvalRows: approvals.value.rows.length,
    }),
  );
} finally {
  await pool.end();
}
