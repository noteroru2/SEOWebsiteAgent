import Link from 'next/link';
import { notFound } from 'next/navigation';
import { aiPanelForOpportunity, opportunityDetail } from '@seo-agent/database';
import { dismissOpportunityAction, enqueueAiAnalysis } from '../../actions';

export const dynamic = 'force-dynamic';
export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, ai] = await Promise.all([opportunityDetail(id), aiPanelForOpportunity(id)]);
  if (!data) notFound();
  const item = data.opportunity;
  const evidence = item.evidence as Record<string, unknown>;
  const score = item.score_components as Record<string, unknown>;
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Opportunity detail</div>
          <h1>{item.title}</h1>
          <p className="muted">
            {item.site_name} · {item.kind}
          </p>
        </div>
        {item.status !== 'DISMISSED' ? (
          <form action={dismissOpportunityAction.bind(null, item.id, item.site_id)}>
            <button className="danger">Dismiss</button>
          </form>
        ) : (
          <span className="pill">DISMISSED</span>
        )}
      </div>
      <div className="stats four">
        <Stat label="Priority" value={item.priority_label} />
        <Stat label="Confidence" value={item.confidence} />
        <Stat label="Score" value={item.score} />
        <Stat label="Status" value={item.status} />
      </div>
      <section className="panel compact section">
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
        <p>
          <strong>Why this was flagged:</strong> {item.summary}
        </p>
        <p>
          <strong>What the system does not know:</strong>{' '}
          {String(
            evidence.unknown ??
              'The deterministic engine cannot establish causation or prescribe a specific change.',
          )}
        </p>
        <p className="hint">
          First detected: {new Date(item.first_detected_at).toLocaleString()} · Last detected:{' '}
          {new Date(item.last_detected_at).toLocaleString()} · Engine: {item.engine_version}
        </p>
      </section>
      <AiRecommendationPanel ai={ai} item={item} />
      <div className="grid section">
        <section className="panel">
          <h2>Structured evidence</h2>
          <EvidenceTable value={evidence} />
        </section>
        <section className="panel">
          <h2>Score components</h2>
          <EvidenceTable value={score} />
        </section>
      </div>
      <div className="grid section">
        <section className="panel">
          <h2>Related crawl findings</h2>
          {data.relatedIssues.length ? (
            data.relatedIssues.map((issue) => (
              <p key={`${issue.rule_code}-${issue.title}`}>
                <span className="pill">{issue.severity}</span> {issue.rule_code} · {issue.title}
              </p>
            ))
          ) : (
            <div className="empty">No related crawl findings</div>
          )}
        </section>
        <section className="panel">
          <h2>Related GSC metrics</h2>
          <EvidenceTable value={data.relatedGsc ?? {}} />
        </section>
      </div>
      <p className="section">
        <Link href="/opportunities">Back to opportunities</Link>
      </p>
      <div className="timing">Query {data.timingMs.toFixed(1)} ms</div>
    </>
  );
}

function AiRecommendationPanel({
  ai,
  item,
}: {
  ai: Awaited<ReturnType<typeof aiPanelForOpportunity>>;
  item: Record<string, unknown>;
}) {
  const latest = ai.latest;
  const result = (latest?.result ?? {}) as Record<string, unknown>;
  const actions = Array.isArray(result.recommended_actions)
    ? (result.recommended_actions as Array<Record<string, unknown>>)
    : [];
  return (
    <section className="panel section ai-panel">
      <div className="heading small">
        <div>
          <div className="eyebrow">AI reasoning · owner review only</div>
          <h2>SEO recommendation</h2>
          <p className="hint">
            One bounded analysis of this persisted opportunity. It cannot edit, publish, deploy, or
            run tools.
          </p>
        </div>
        {ai.activeJob ? (
          <button disabled>{ai.activeJob.status === 'RUNNING' ? 'Analyzing…' : 'Queued'}</button>
        ) : latest?.status === 'SUCCEEDED' || latest?.status === 'REUSED' ? (
          <form action={enqueueAiAnalysis.bind(null, String(item.id), String(item.site_id), true)}>
            <button disabled={!ai.configured || !['OPEN', 'MONITOR'].includes(String(item.status))}>
              Reanalyze (additional cost)
            </button>
          </form>
        ) : (
          <form action={enqueueAiAnalysis.bind(null, String(item.id), String(item.site_id), false)}>
            <button disabled={!ai.configured || !['OPEN', 'MONITOR'].includes(String(item.status))}>
              Analyze opportunity
            </button>
          </form>
        )}
      </div>
      {!ai.configured ? (
        <div className="notice">OPENAI_API_KEY is not configured on the server.</div>
      ) : null}
      {!latest ? (
        <div className="empty compact-empty">No AI analysis has been requested.</div>
      ) : ['FAILED', 'CANCELLED'].includes(latest.status) ? (
        <div className="notice danger-text">
          {latest.failure_code}: {latest.failure_summary}
        </div>
      ) : latest.status === 'RUNNING' || latest.status === 'QUEUED' ? (
        <div className="empty compact-empty">Analysis {latest.status.toLowerCase()}.</div>
      ) : (
        <>
          <div className="stats four ai-stats">
            <Stat label="Verdict" value={latest.verdict ?? '—'} />
            <Stat label="Confidence" value={latest.recommendation_confidence ?? '—'} />
            <Stat label="Risk ceiling" value={highestRisk(actions)} />
            <Stat label="Cost" value={formatUsd(latest.actual_cost_micros)} />
          </div>
          <p>{latest.recommendation_summary}</p>
          <h2>Recommended owner-reviewed actions</h2>
          {actions.length ? (
            <div className="recommendation-actions">
              {actions.map((action, index) => (
                <article key={`${String(action.action_type)}-${index}`}>
                  <div className="opportunity-meta">
                    <span className="pill">{String(action.action_type)}</span>
                    <span className="pill">{String(action.risk)} RISK</span>
                    <span className="pill">HUMAN REVIEW REQUIRED</span>
                  </div>
                  <strong>{String(action.title)}</strong>
                  <p>{String(action.description)}</p>
                  <p className="hint">Goal: {String(action.expected_goal)}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty compact-empty">No action recommended.</div>
          )}
          <div className="grid ai-evidence">
            <AiList title="Evidence used" values={result.evidence_used} />
            <AiList title="Unknowns" values={result.unknowns} />
            <AiList title="Additional evidence needed" values={result.additional_evidence_needed} />
            <AiList title="Do not do" values={result.do_not_do} />
          </div>
          <p className="hint section">
            Model: {latest.model} · Prompt: {latest.prompt_version} · Schema:{' '}
            {latest.schema_version}
            {' · '}Completed:{' '}
            {latest.finished_at ? new Date(latest.finished_at).toLocaleString() : '—'}
            {' · '}Provider latency: {latest.latency_ms ?? 0} ms
            {latest.status === 'REUSED' ? ' · Reused prior identical analysis (no API call)' : ''}
          </p>
        </>
      )}
    </section>
  );
}

function AiList({ title, values }: { title: string; values: unknown }) {
  const list = Array.isArray(values) ? values : [];
  return (
    <section>
      <h2>{title}</h2>
      {list.length ? (
        <ul>
          {list.map((value, index) => (
            <li key={index}>
              {typeof value === 'object' && value
                ? String((value as Record<string, unknown>).fact ?? JSON.stringify(value))
                : String(value)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">None recorded.</p>
      )}
    </section>
  );
}

function highestRisk(actions: Array<Record<string, unknown>>) {
  return (
    ['HIGH', 'MEDIUM', 'LOW'].find((risk) => actions.some((action) => action.risk === risk)) ?? '—'
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
function EvidenceTable({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="facts one">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</dd>
        </div>
      ))}
    </dl>
  );
}
