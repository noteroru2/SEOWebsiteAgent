import { listJobs } from '@seo-agent/database';
import { enqueueSystemTest } from '../actions';

export const dynamic = 'force-dynamic';
export default async function Jobs() {
  const data: Awaited<ReturnType<typeof listJobs>> = await listJobs().catch(() => ({
    rows: [],
    timingMs: 0,
  }));
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Operations</div>
          <h1>Jobs</h1>
          <p className="muted">Persistent work history and current queue state.</p>
        </div>
        <form action={enqueueSystemTest}>
          <button>Enqueue SYSTEM_TEST</button>
        </form>
      </div>
      <section className="panel">
        {data.rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Started</th>
                <th>Failure</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((job) => (
                <tr key={job.id}>
                  <td>{job.type}</td>
                  <td>
                    <span className="pill">{job.status}</span>
                  </td>
                  <td>
                    {job.attemptCount}/{job.maxAttempts}
                  </td>
                  <td>{job.startedAt?.toLocaleString() ?? '—'}</td>
                  <td>{job.failureSummary ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No jobs yet</div>
        )}
        <div className="timing">Query {data.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
