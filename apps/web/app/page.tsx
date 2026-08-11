import Link from 'next/link';
import {
  aiSpendSummary,
  dashboardSummary,
  dashboardTopOpportunities,
  databaseHealthy,
} from '@seo-agent/database';
import { enqueueSystemTest } from './actions';

export const dynamic = 'force-dynamic';
export default async function Dashboard() {
  let data: Awaited<ReturnType<typeof dashboardSummary>> | null = null;
  let dbHealthy = false;
  let top: Awaited<ReturnType<typeof dashboardTopOpportunities>> = { rows: [], timingMs: 0 };
  let aiSpend: Awaited<ReturnType<typeof aiSpendSummary>> | null = null;
  try {
    [data, dbHealthy, top, aiSpend] = await Promise.all([
      dashboardSummary(),
      databaseHealthy(),
      dashboardTopOpportunities(),
      aiSpendSummary(),
    ]);
  } catch {
    /* health state is rendered */
  }
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Overview</div>
          <h1>Dashboard</h1>
        </div>
        <form action={enqueueSystemTest}>
          <button type="submit">Run system test</button>
        </form>
      </div>
      <div className="stats">
        <Stat label="Sites" value={data?.sites ?? 0} />
        <Stat label="Agent" value={data?.workerHealthy ? 'Active' : 'Idle'} />
        <Stat label="Jobs running" value={data?.running ?? 0} />
        <Stat label="Needs approval" value={data?.pending ?? 0} />
        <Stat label="AI spend (month)" value={formatUsd(aiSpend?.cost_micros)} />
      </div>
      <section className="panel compact section">
        <div className="health ai-summary">
          <div>
            <span>AI analyses this month</span>
            <strong>{aiSpend?.analyses ?? 0}</strong>
          </div>
          <div>
            <span>Provider calls</span>
            <strong>{aiSpend?.provider_calls ?? 0}</strong>
          </div>
          <div>
            <span>Average call cost</span>
            <strong>{formatUsd(aiSpend?.average_cost_micros)}</strong>
          </div>
          <div>
            <span>Global monthly budget</span>
            <strong>{formatUsd(aiSpend?.budgetMicros)}</strong>
          </div>
        </div>
      </section>
      <div className="grid">
        <section className="panel">
          <h2>Recent jobs</h2>
          {data?.recentJobs.length ? (
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.type}</td>
                    <td>
                      <span className="pill">{j.status}</span>
                    </td>
                    <td>{j.createdAt.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No jobs yet</div>
          )}
          <div className="timing">Query {data?.timingMs.toFixed(1) ?? '—'} ms</div>
        </section>
        <section className="panel">
          <h2>System health</h2>
          <div className="health">
            <Health label="Database" healthy={dbHealthy} />
            <Health label="Worker" healthy={data?.workerHealthy ?? false} />
            <Health label="Queue" healthy={dbHealthy} />
          </div>
        </section>
      </div>
      <section className="panel section">
        <div className="heading small">
          <h2>Top Opportunities</h2>
          <Link href="/opportunities">View all</Link>
        </div>
        {top.rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Type</th>
                <th>Site</th>
                <th>Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {top.rows.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="pill">{item.priority_label}</span>
                  </td>
                  <td>{item.kind}</td>
                  <td>{item.site_name}</td>
                  <td>{item.score}</td>
                  <td>
                    <Link href={`/opportunities/${item.id}`}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No generated opportunities yet</div>
        )}
        <div className="timing">Query {top.timingMs.toFixed(1)} ms · top 5 persisted records</div>
      </section>
    </>
  );
}
function formatUsd(value: unknown) {
  return `$${(Number(value ?? 0) / 1_000_000).toFixed(4)}`;
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Health({ label, healthy }: { label: string; healthy: boolean }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={healthy ? 'ok' : 'warn'}>{healthy ? 'Healthy' : 'Unavailable'}</strong>
    </div>
  );
}
