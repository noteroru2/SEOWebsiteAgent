import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  aiSpendSummary,
  gscSiteStatus,
  manualCommandSnapshot,
  siteDetail,
  siteOpportunitySummary,
  siteSourceSummary,
} from '@seo-agent/database';
import { RunNowControl } from '../../run-now-control';
import { displayUtcTimestamp, formatOwnerDomainName } from '@seo-agent/shared';
import {
  cancelCrawl,
  connectSourceRepositoryAction,
  enqueueOpportunityGeneration,
  enqueueSiteCrawl,
  enqueueSourceRefresh,
} from '../../actions';

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
  const [data, gsc, opportunities, aiSpend, source, commandState] = await Promise.all([
    siteDetail(id, filters),
    gscSiteStatus(id),
    siteOpportunitySummary(id),
    aiSpendSummary(id),
    siteSourceSummary(id),
    manualCommandSnapshot(),
  ]);
  if (!data) notFound();
  const summary = (data.latest?.summary ?? {}) as Record<string, unknown>;
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Site detail</div>
          <h1>
            {formatOwnerDomainName(data.site.name.includes('?') ? data.site.url : data.site.name)}
          </h1>
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
      <section className="panel compact section command-center">
        <div className="heading small">
          <div>
            <h2>Manual Command</h2>
            <p className="hint">
              สั่ง Opportunity Watch สำหรับเว็บไซต์นี้ผ่าน Worker pipeline ทันที
            </p>
          </div>
          <RunNowControl
            siteId={id}
            compact
            disabledReason={siteManualDisabledReason(data.site, source, commandState)}
          />
        </div>
      </section>
      <section className="panel compact section">
        <div className="heading small">
          <div>
            <h2>Source Repository</h2>
            {source ? (
              <p className="hint">
                Connected · {source.local_path} · HEAD{' '}
                {String(source.head_sha ?? 'Not refreshed').slice(0, 8)} · Branch{' '}
                {source.current_branch ?? '—'} · Worktree{' '}
                {source.worktree_clean === true
                  ? 'Clean'
                  : source.worktree_clean === false
                    ? 'Dirty'
                    : 'Not checked'}{' '}
                · Routes {source.routes_mapped ?? 0} · Unresolved {source.unresolved_routes ?? 0}
              </p>
            ) : (
              <p className="hint">
                Not connected. Enter one explicit local Git root; filesystem browsing is
                unavailable.
              </p>
            )}
          </div>
          {source ? (
            <form action={enqueueSourceRefresh.bind(null, id)}>
              <button>Refresh Source</button>
            </form>
          ) : null}
        </div>
        {!source ? (
          <form className="filters" action={connectSourceRepositoryAction.bind(null, id)}>
            <input name="localRoot" required placeholder="Absolute local repository root" />
            <button>Connect Source Repository</button>
          </form>
        ) : null}
      </section>
      <section className="panel compact section">
        <div className="heading small">
          <div>
            <h2>Google Search Console</h2>
            <p className="hint">
              {gsc?.status === 'CONNECTED' ? 'Connected' : 'Not connected'} · Property:{' '}
              {gsc?.property_uri ?? 'Not selected'} · Last sync:{' '}
              {gsc?.last_sync_at ? displayUtcTimestamp(gsc.last_sync_at) : 'Never'} · Status:{' '}
              {gsc?.latest_status ??
                (gsc?.status === 'CONNECTED' ? 'Needs Attention' : 'Not configured')}
            </p>
          </div>
          <Link href={`/sites/${id}/search-console`}>Open Search Console</Link>
        </div>
      </section>
      <section className="panel compact section">
        <div className="heading small">
          <div>
            <h2>SEO Opportunities</h2>
            <p className="hint">
              Open: {opportunities.counts.open ?? 0} · High: {opportunities.counts.high ?? 0} ·
              Medium: {opportunities.counts.medium ?? 0} · Low: {opportunities.counts.low ?? 0}
              {' · '}Last run: {opportunities.latestRun?.status ?? 'Never'}
            </p>
          </div>
          <div className="filters actions-inline">
            <Link href={`/opportunities?siteId=${id}`}>View All</Link>
            <form action={enqueueOpportunityGeneration.bind(null, id)}>
              <button disabled={!!opportunities.activeJob}>
                {opportunities.activeJob ? 'Generation active' : 'Generate Opportunities'}
              </button>
            </form>
          </div>
        </div>
        {opportunities.top.length ? (
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Type</th>
                <th>Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {opportunities.top.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="pill">{item.priority_label}</span>
                  </td>
                  <td>{item.kind}</td>
                  <td>{item.score}</td>
                  <td>
                    <Link href={`/opportunities/${item.id}`}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty compact-empty">
            Generate a deterministic opportunity set from the latest crawl and GSC data.
          </div>
        )}
        <div className="timing">
          Query {opportunities.timingMs.toFixed(1)} ms · top 3 persisted records
        </div>
      </section>
      <section className="panel compact section">
        <h2>AI recommendation spend</h2>
        <p className="hint">
          This month: ${(Number(aiSpend.cost_micros) / 1_000_000).toFixed(4)} of $
          {(Number(aiSpend.budgetMicros) / 1_000_000).toFixed(2)} · Analyses: {aiSpend.analyses}
          {' · '}Average provider call: $
          {(Number(aiSpend.average_cost_micros) / 1_000_000).toFixed(4)}
        </p>
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

function siteManualDisabledReason(
  site: { active: boolean; sourceStatus: string },
  source: { worktree_clean?: boolean | null } | null,
  state: Awaited<ReturnType<typeof manualCommandSnapshot>>,
) {
  if (process.env.LOCAL_MANUAL_COMMANDS_ENABLED !== 'true')
    return 'Local manual commands are disabled';
  if (!state.worker.healthy) return 'WORKER_UNAVAILABLE';
  if (!state.executor.ready) return state.executor.status;
  if (!site.active) return 'SITE_INACTIVE';
  if (site.sourceStatus !== 'CURRENT') return 'SOURCE_NOT_CURRENT';
  if (!source) return 'SOURCE_NOT_CONFIGURED';
  if (source.worktree_clean !== true) return 'SOURCE_WORKTREE_NOT_CLEAN';
  return null;
}
