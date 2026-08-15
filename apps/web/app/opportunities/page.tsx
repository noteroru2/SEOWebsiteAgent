import Link from 'next/link';
import {
  listOpportunities,
  getLatestOpportunityWatchRun,
  getGoldenPathCandidates,
} from '@seo-agent/database';
import { triggerOpportunityWatchAction } from '../actions';
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
  const activeSiteId = filters.siteId || 'f4ab6ec8-8cdb-4444-a6b6-3dc5c4d20bac';
  const watchRun = await getLatestOpportunityWatchRun(activeSiteId);
  const candidates = await getGoldenPathCandidates(activeSiteId);

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

      <section className="panel section" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="eyebrow">Continuous Production Watch</div>
            <h2>Opportunity Detection Watch</h2>
            <p className="hint">
              Cadence: <strong>DAILY (09:15 Asia/Bangkok)</strong> · Heavy Concurrency: <strong>1</strong> · Detection Only
            </p>
          </div>
          <form action={triggerOpportunityWatchAction.bind(null, activeSiteId)}>
            <button type="submit">Run Detection Watch (Verification)</button>
          </form>
        </div>

        {candidates.length > 0 ? (
          <div className="notice success-text" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="pill priority-high">GOLDEN PATH CANDIDATE READY</span>
              <strong>Golden Path Candidate Ready</strong>
            </div>
            <p className="hint" style={{ marginTop: '0.25rem' }}>
              A genuine production candidate has satisfied all evidence, sample, and safety rules for owner review.
            </p>
            <div style={{ marginTop: '1rem' }}>
              {candidates.map((c) => (
                <div key={c.id} className="notice" style={{ marginBottom: '0.5rem' }}>
                  <p><strong>Query:</strong> {c.query}</p>
                  <p><strong>Target:</strong> {c.target_url}</p>
                  <p><strong>Reason:</strong> {c.selection_reason}</p>
                  <p className="hint">Risk: {c.risk} · Sample: {c.sample_sufficiency} · Source: {c.source_file}</p>
                  <div style={{ marginTop: '0.5rem' }}>
                    <Link href={`/opportunities/${c.opportunity_id}`}>
                      <button>Start Governed Review</button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="notice" style={{ marginTop: '1rem' }}>
            <p>
              <strong>No Golden Path candidate currently meets the evidence and safety requirements.</strong>
            </p>
            <p className="hint">
              SEO Agent will continue monitoring new production data. Scheduled watch calls 0 OpenAI and 0 SERP APIs.
            </p>
          </div>
        )}

        <div className="timing" style={{ marginTop: '0.75rem' }}>
          Last Watch Run:{' '}
          {watchRun?.finished_at ? new Date(watchRun.finished_at).toLocaleString() : 'Not executed yet'}
          {' · '}Active Opportunities: {data.rows.length}
          {' · '}Qualified Candidates: {candidates.length}
        </div>
      </section>

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
