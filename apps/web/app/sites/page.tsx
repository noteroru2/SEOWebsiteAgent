import { listSites } from '@seo-agent/database';

export const dynamic = 'force-dynamic';
export default async function Sites() {
  const data: Awaited<ReturnType<typeof listSites>> = await listSites().catch(() => ({
    rows: [],
    timingMs: 0,
  }));
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Connections</div>
          <h1>Sites</h1>
          <p className="muted">Website records available to the local agent.</p>
        </div>
      </div>
      <section className="panel">
        {data.rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((site) => (
                <tr key={site.id}>
                  <td>{site.name}</td>
                  <td>{site.url}</td>
                  <td>
                    <span className="pill">{site.active ? 'ACTIVE' : 'PAUSED'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No sites connected</div>
        )}
        <div className="timing">Query {data.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
