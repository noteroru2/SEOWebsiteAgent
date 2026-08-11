import Link from 'next/link';
import { listSites } from '@seo-agent/database';
import { createConfiguredSite, enqueueSiteCrawl } from '../actions';

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
          <p className="muted">Bounded, read-only website inspection.</p>
        </div>
      </div>
      <section className="panel compact">
        <h2>Add site</h2>
        <form action={createConfiguredSite} className="site-form">
          <label>
            Name
            <input name="name" minLength={2} maxLength={120} required />
          </label>
          <label>
            Base URL
            <input name="url" type="url" placeholder="https://example.com/" required />
          </label>
          <label>
            Max pages
            <input name="maxPages" type="number" min="1" max="5000" defaultValue="500" required />
          </label>
          <button type="submit">Add site</button>
        </form>
        <p className="hint">
          Public HTTP(S) sites only. Private, loopback, link-local, and metadata targets are
          blocked.
        </p>
      </section>
      <section className="panel">
        {data.rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Status</th>
                <th>Last crawl</th>
                <th>Pages</th>
                <th>Indexable</th>
                <th>Issues</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((site) => (
                <tr key={site.id}>
                  <td>
                    <Link href={`/sites/${site.id}`}>
                      <strong>{site.name}</strong>
                    </Link>
                    <small>{site.url}</small>
                  </td>
                  <td>
                    <span className="pill">
                      {site.crawlStatus ?? (site.crawlEnabled ? 'READY' : 'DISABLED')}
                    </span>
                  </td>
                  <td>{site.lastCrawlAt?.toLocaleString() ?? '—'}</td>
                  <td>{site.pagesCrawled}</td>
                  <td>{site.indexablePages}</td>
                  <td>{site.issueCount}</td>
                  <td>
                    <form action={enqueueSiteCrawl.bind(null, site.id)}>
                      <button type="submit" disabled={!site.active || !site.crawlEnabled}>
                        Run crawl
                      </button>
                    </form>
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
