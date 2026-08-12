import { listSourceApprovals } from '@seo-agent/database';
import { decideSourcePlanAction } from '../actions';

export const dynamic = 'force-dynamic';
export default async function Approvals() {
  const plans = await listSourceApprovals();
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Safety gate</div>
          <h1>Approvals</h1>
          <p className="muted">Risky actions always wait for explicit approval.</p>
        </div>
      </div>
      <section className="panel">
        <h2>Source Change Plans</h2>
        <p className="hint">
          Approval does not change the website. It only marks the plan as approved for a future
          execution-preparation step.
        </p>
        {plans.rows.length ? (
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
              {plans.rows.map((plan) => (
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
        ) : (
          <div className="empty">Nothing needs approval</div>
        )}
        <div className="timing">Query {plans.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
