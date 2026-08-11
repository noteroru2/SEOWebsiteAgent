import { dashboardSummary, databaseHealthy } from '@seo-agent/database';
import { enqueueSystemTest } from './actions';

export const dynamic = 'force-dynamic';
export default async function Dashboard() {
  let data: Awaited<ReturnType<typeof dashboardSummary>> | null = null;
  let dbHealthy = false;
  try {
    data = await dashboardSummary();
    dbHealthy = await databaseHealthy();
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
        <Stat label="AI cost" value={`฿${((data?.aiCostMicros ?? 0) / 1_000_000).toFixed(2)}`} />
      </div>
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
    </>
  );
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
