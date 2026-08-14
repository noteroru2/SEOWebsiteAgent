import Link from 'next/link';
import { getDatabase, listPatchWorkflows, listSourceApprovals } from '@seo-agent/database';
import { decideSourcePlanAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const { db } = getDatabase();
  const workflows = await listPatchWorkflows(db);
  const legacyPlans = await listSourceApprovals();

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Owner Control Center</div>
          <h1>Approvals & Release Control</h1>
          <p className="muted">
            Govern website patches, evidence, validation, production release authorization, and
            rollback.
          </p>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: '32px' }}>
        <h2>Patch Workflows ({workflows.rows.length})</h2>
        <p className="hint">
          Governed Batch 8+ patch workflows. Approving a patch authorizes validation, NOT production
          release.
        </p>

        {workflows.rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Subject</th>
                <th>Query / Target Route</th>
                <th>Risk</th>
                <th>Workflow Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {workflows.rows.map((wf: any) => (
                <tr key={wf.id}>
                  <td>
                    <strong>{wf.siteName || 'Unknown Site'}</strong>
                  </td>
                  <td>
                    <span className="provenance-tag prov-source">{wf.subjectType}</span>
                  </td>
                  <td>
                    <div>
                      <strong>{wf.query || wf.targetRoutePath}</strong>
                    </div>
                    <small className="muted">{wf.targetSourcePath}</small>
                  </td>
                  <td>
                    <span className={`badge-${(wf.risk || 'LOW').toLowerCase()}`}>
                      {wf.risk || 'LOW'}
                    </span>
                  </td>
                  <td>
                    <span className="pill">{wf.status}</span>
                  </td>
                  <td>{wf.createdAt ? new Date(wf.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    <Link
                      href={`/approvals/${wf.id}`}
                      className="button"
                      style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        fontSize: '13px',
                        textDecoration: 'none',
                        background: '#13271d',
                        color: '#fff',
                        borderRadius: '6px',
                      }}
                    >
                      Control Center &rarr;
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No patch workflows in queue.</div>
        )}
        <div className="timing">Query {workflows.timingMs.toFixed(1)} ms</div>
      </section>

      {legacyPlans.rows.length > 0 && (
        <section className="panel">
          <h2>Legacy Source Change Plans</h2>
          <p className="hint">
            Unconverted legacy source change plans requiring initial plan review.
          </p>
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Opportunity</th>
                <th>Status</th>
                <th>Summary</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {legacyPlans.rows.map((plan) => (
                <tr key={plan.id}>
                  <td>{plan.site_name}</td>
                  <td>{plan.opportunity_title}</td>
                  <td>
                    <span className="pill">{plan.status}</span>
                  </td>
                  <td>{plan.summary}</td>
                  <td>
                    {plan.status === 'READY_FOR_REVIEW' ? (
                      <div className="actions-inline">
                        <form action={decideSourcePlanAction.bind(null, plan.id, 'APPROVED')}>
                          <button>Approve Plan</button>
                        </form>
                        <form action={decideSourcePlanAction.bind(null, plan.id, 'REJECTED')}>
                          <button className="danger">Reject Plan</button>
                        </form>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="timing">Query {legacyPlans.timingMs.toFixed(1)} ms</div>
        </section>
      )}
    </>
  );
}
