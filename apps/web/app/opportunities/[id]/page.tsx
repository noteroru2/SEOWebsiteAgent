import Link from 'next/link';
import { notFound } from 'next/navigation';
import { opportunityDetail } from '@seo-agent/database';
import { dismissOpportunityAction } from '../../actions';

export const dynamic = 'force-dynamic';
export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await opportunityDetail(id);
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
