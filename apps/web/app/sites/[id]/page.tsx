import Link from 'next/link';
import { notFound } from 'next/navigation';
import { gscSiteStatus, siteDetail } from '@seo-agent/database';
import { cancelCrawl, enqueueSiteCrawl } from '../../actions';

export const dynamic = 'force-dynamic';
export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ severity?: string; category?: string; code?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const [data, gsc] = await Promise.all([siteDetail(id, filters), gscSiteStatus(id)]);
  if (!data) notFound();
  const summary = (data.latest?.summary ?? {}) as Record<string, unknown>;
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Site detail</div>
          <h1>{data.site.name}</h1>
          <p className="muted">{data.site.url}</p>
        </div>
        {data.runningJob ? (
          <form action={cancelCrawl.bind(null, data.runningJob.id, id)}>
            <button className="danger">Request cancellation</button>
          </form>
        ) : (
          <form action={enqueueSiteCrawl.bind(null, id)}>
            <button disabled={!data.site.crawlEnabled}>Run crawl</button>
          </form>
        )}
      </div>
      <div className="stats four">
        <Stat label="Crawl status" value={data.latest?.status ?? 'Not run'} />
        <Stat label="Pages crawled" value={data.latest?.pagesCrawled ?? 0} />
        <Stat label="Indexable" value={data.latest?.pagesIndexable ?? 0} />
        <Stat label="Issues" value={data.latest?.issuesFound ?? 0} />
      </div>
      <section className="panel compact section">
        <div className="heading small">
          <div>
            <h2>Google Search Console</h2>
            <p className="hint">
              {gsc?.status === 'CONNECTED' ? 'Connected' : 'Not connected'} · Property:{' '}
              {gsc?.property_uri ?? 'Not selected'} · Last sync:{' '}
              {gsc?.last_sync_at ? new Date(gsc.last_sync_at).toLocaleString() : 'Never'} · Status:{' '}
              {gsc?.latest_status ??
                (gsc?.status === 'CONNECTED' ? 'Needs Attention' : 'Not configured')}
            </p>
          </div>
          <Link href={`/sites/${id}/search-console`}>Open Search Console</Link>
        </div>
      </section>
      <div className="grid">
        <section className="panel">
          <h2>Latest crawl</h2>
          {data.latest ? (
            <dl className="facts">
              <div>
                <dt>Started</dt>
                <dd>{data.latest.startedAt?.toLocaleString() ?? '—'}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{data.latest.durationMs ?? 0} ms</dd>
              </div>
              <div>
                <dt>Discovered</dt>
                <dd>{data.latest.pagesDiscovered}</dd>
              </div>
              <div>
                <dt>HTTP 4xx / 5xx</dt>
                <dd>
                  {String(summary.http4xx ?? 0)} / {String(summary.http5xx ?? 0)}
                </dd>
              </div>
            </dl>
          ) : (
            <div className="empty">No crawl yet</div>
          )}
        </section>
        <section className="panel">
          <h2>Safety limits</h2>
          <div className="health">
            <div>
              <span>Max pages</span>
              <strong>{data.site.maxPages}</strong>
            </div>
            <div>
              <span>Delay</span>
              <strong>{data.site.crawlDelayMs} ms</strong>
            </div>
            <div>
              <span>Timeout</span>
              <strong>{data.site.requestTimeoutMs} ms</strong>
            </div>
          </div>
        </section>
      </div>
      <section className="panel section">
        <div className="heading small">
          <div>
            <h2>Issues</h2>
            <p className="hint">
              Orphan candidates are indicative only because crawls are bounded.
            </p>
          </div>
          <Link href={`/sites/${id}`}>Clear filters</Link>
        </div>
        <form className="filters">
          <select name="severity" defaultValue={filters.severity ?? ''}>
            <option value="">All severities</option>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <input name="category" placeholder="Category" defaultValue={filters.category} />
          <input name="code" placeholder="Issue code" defaultValue={filters.code} />
          <button>Filter</button>
        </form>
        {data.issues.length ? (
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Code</th>
                <th>URL</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {data.issues.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="pill">{item.severity}</span>
                  </td>
                  <td>{item.ruleCode}</td>
                  <td className="url-cell">{item.url}</td>
                  <td>{item.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No issues for this view</div>
        )}
      </section>
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
