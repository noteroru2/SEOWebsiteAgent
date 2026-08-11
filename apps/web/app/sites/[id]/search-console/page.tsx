import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSite, gscSiteView } from '@seo-agent/database';
import { disconnectGoogle, enqueueGscSync, selectGscProperty } from '../../../actions';

export const dynamic = 'force-dynamic';
const number = (value: unknown) => Number(value ?? 0).toLocaleString();
const percent = (value: unknown) => `${(Number(value ?? 0) * 100).toFixed(2)}%`;
export default async function SearchConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ query?: string; page?: string; connected?: string; error?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const site = await getSite(id);
  if (!site) notFound();
  const data = await gscSiteView(id, filters);
  const current = (data.summary?.current_metrics ?? {}) as Record<string, unknown>;
  const previous = (data.summary?.previous_metrics ?? {}) as Record<string, unknown>;
  const delta = (data.summary?.deltas ?? {}) as Record<string, unknown>;
  const connected = data.connection?.status === 'CONNECTED';
  const selected = data.properties.find((item) => item.selected);
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Google Search Console</div>
          <h1>{site.name}</h1>
          <p className="muted">Read-only finalized web search data</p>
        </div>
        <Link href={`/sites/${id}`}>Back to site</Link>
      </div>
      {filters.connected && (
        <p className="notice">Google connected. Select a property before syncing.</p>
      )}
      {filters.error && <p className="notice danger-text">OAuth connection failed safely.</p>}
      <section className="panel compact">
        <div className="heading small">
          <div>
            <h2>Connection</h2>
            <p className="hint">
              Status: {connected ? 'Connected' : 'Not connected'} · Property:{' '}
              {selected?.property_uri ?? 'Not selected'}
            </p>
          </div>
          {connected ? (
            <form action={disconnectGoogle.bind(null, id)}>
              <button className="danger">Disconnect</button>
            </form>
          ) : (
            <a className="button-link" href={`/api/google/connect?siteId=${id}`}>
              Connect Google
            </a>
          )}
        </div>
        {connected && (
          <form className="filters" action={selectGscProperty.bind(null, id)}>
            <select name="propertyId" defaultValue={selected?.id ?? ''}>
              <option value="" disabled>
                Select property
              </option>
              {data.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.property_uri} ({p.permission_level})
                </option>
              ))}
            </select>
            <button>Select Property</button>
          </form>
        )}
        {selected && (
          <div className="filters">
            <form action={enqueueGscSync.bind(null, id, 'INCREMENTAL')}>
              <button>Sync Now</button>
            </form>
            {!data.summary && (
              <form action={enqueueGscSync.bind(null, id, 'BOOTSTRAP_28D')}>
                <button>Bootstrap 28 Days</button>
              </form>
            )}
          </div>
        )}
      </section>
      <div className="stats four">
        <Stat label="28d clicks" value={number(current.clicks)} />
        <Stat label="28d impressions" value={number(current.impressions)} />
        <Stat label="28d CTR" value={percent(current.ctr)} />
        <Stat label="Avg position" value={Number(current.position ?? 0).toFixed(2)} />
      </div>
      <section className="panel section">
        <h2>Overview</h2>
        <p className="hint">
          Last finalized date: {data.summary?.last_finalized_date ?? '—'} · Coverage:{' '}
          {data.summary?.coverage_status ?? 'Not synced'} · Rows stored:{' '}
          {number(data.summary?.rows_stored)}
        </p>
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Clicks</th>
              <th>Impressions</th>
              <th>CTR</th>
              <th>Position</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow name="Current 28d" value={current} />
            <MetricRow name="Previous 28d" value={previous} />
            <MetricRow name="Change" value={delta} />
          </tbody>
        </table>
      </section>
      <section className="panel section">
        <div className="heading small">
          <h2>Queries</h2>
          <form className="filters">
            <input name="query" placeholder="Query contains" defaultValue={filters.query} />
            <button>Filter</button>
          </form>
        </div>
        <MetricTable rows={data.queries} keyName="query" />
      </section>
      <section className="panel section">
        <div className="heading small">
          <h2>Pages</h2>
          <form className="filters">
            <input name="page" placeholder="Page contains" defaultValue={filters.page} />
            <button>Filter</button>
          </form>
        </div>
        <MetricTable rows={data.pages} keyName="page" />
      </section>
      <section className="panel section">
        <h2>Query × Page</h2>
        <p className="hint">
          Bounded to 50 rows. This is raw deterministic data, not a cannibalization diagnosis.
        </p>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Query</th>
              <th>Page</th>
              <th>Clicks</th>
              <th>Impressions</th>
            </tr>
          </thead>
          <tbody>
            {data.queryPages.map((r, i) => (
              <tr key={i}>
                <td>{r.metric_date}</td>
                <td>{r.query}</td>
                <td className="url-cell">{r.page}</td>
                <td>{number(r.clicks)}</td>
                <td>{number(r.impressions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel section">
        <h2>Sync History</h2>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Mode</th>
              <th>Dates</th>
              <th>Requests</th>
              <th>Rows</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td>{r.status}</td>
                <td>{r.mode}</td>
                <td>
                  {r.start_date} – {r.end_date}
                </td>
                <td>{r.api_requests}</td>
                <td>{r.rows_received}</td>
                <td>{r.coverage_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="timing">Bounded queries completed in {data.timingMs.toFixed(1)} ms</p>
      </section>
    </>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function MetricRow({ name, value }: { name: string; value: Record<string, unknown> }) {
  return (
    <tr>
      <td>{name}</td>
      <td>{number(value.clicks)}</td>
      <td>{number(value.impressions)}</td>
      <td>{percent(value.ctr)}</td>
      <td>{Number(value.position ?? 0).toFixed(2)}</td>
    </tr>
  );
}
function MetricTable({
  rows,
  keyName,
}: {
  rows: Array<Record<string, unknown>>;
  keyName: 'query' | 'page';
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{keyName}</th>
          <th>Clicks</th>
          <th>Impressions</th>
          <th>CTR</th>
          <th>Position</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="url-cell">{String(r[keyName])}</td>
            <td>{number(r.clicks)}</td>
            <td>{number(r.impressions)}</td>
            <td>{percent(r.ctr)}</td>
            <td>{Number(r.position ?? 0).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
