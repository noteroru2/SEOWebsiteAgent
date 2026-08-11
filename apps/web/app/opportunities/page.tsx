import Link from 'next/link';
import { listOpportunities } from '@seo-agent/database';
import { OPPORTUNITY_TYPES } from '@seo-agent/opportunity-engine';

export const dynamic = 'force-dynamic';
export default async function Opportunities({
  searchParams,
}: {
  searchParams: Promise<{
    siteId?: string;
    priority?: string;
    type?: string;
    status?: string;
    query?: string;
    url?: string;
  }>;
}) {
  const filters = await searchParams;
  const data = await listOpportunities(filters);
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Recommendations</div>
          <h1>SEO Opportunities</h1>
          <p className="muted">
            A compact, deterministic list of evidence-backed items worth investigating.
          </p>
        </div>
      </div>
      <div className="stats three">
        <Stat label="High" value={data.counts.HIGH ?? 0} />
        <Stat label="Medium" value={data.counts.MEDIUM ?? 0} />
        <Stat label="Low" value={data.counts.LOW ?? 0} />
      </div>
      <section className="panel compact section">
        <form className="filters wrap">
          <select name="siteId" defaultValue={filters.siteId ?? ''}>
            <option value="">All sites</option>
            {data.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue={filters.priority ?? ''}>
            <option value="">All priorities</option>
            {['HIGH', 'MEDIUM', 'LOW'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select name="type" defaultValue={filters.type ?? ''}>
            <option value="">All types</option>
            {OPPORTUNITY_TYPES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select name="status" defaultValue={filters.status ?? 'OPEN'}>
            {['OPEN', 'MONITOR', 'RESOLVED', 'DISMISSED'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <input name="query" placeholder="Query contains" defaultValue={filters.query} />
          <input name="url" placeholder="URL contains" defaultValue={filters.url} />
          <button>Filter</button>
        </form>
      </section>
      <section className="panel section">
        {data.rows.length ? (
          <div className="opportunity-list">
            {data.rows.map((item) => {
              const evidence = item.evidence as Record<string, unknown>;
              return (
                <article className="opportunity-card" key={item.id}>
                  <div className="opportunity-meta">
                    <span className={`pill priority-${String(item.priority_label).toLowerCase()}`}>
                      {item.priority_label}
                    </span>
                    <span className="pill">{item.kind}</span>
                    <strong>Score {item.score}</strong>
                    <span>Confidence {item.confidence}</span>
                  </div>
                  <h2>{item.title}</h2>
                  {item.query ? (
                    <p>
                      <strong>Query:</strong> {item.query}
                    </p>
                  ) : null}
                  {item.url ? (
                    <p className="url-cell">
                      <strong>Page:</strong> {item.url}
                    </p>
                  ) : null}
                  <p>{item.summary}</p>
                  <p className="hint">
                    Impressions:{' '}
                    {String(
                      evidence.currentImpressions ??
                        (evidence.current as { impressions?: number })?.impressions ??
                        evidence.totalImpressions ??
                        '—',
                    )}
                    {' · '}Position:{' '}
                    {formatNumber(
                      evidence.currentPosition ??
                        (evidence.current as { position?: number })?.position,
                    )}
                  </p>
                  <Link href={`/opportunities/${item.id}`}>View evidence</Link>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty">No opportunities for this view</div>
        )}
        <div className="timing">Query {data.timingMs.toFixed(1)} ms · bounded to 100 records</div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function formatNumber(value: unknown) {
  return typeof value === 'number' ? value.toFixed(2) : '—';
}
