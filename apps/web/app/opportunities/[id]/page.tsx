import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  aiPanelForOpportunity,
  opportunityDetail,
  sourcePanelForOpportunity,
  deterministicEvidencePacket,
  evidencePanelForOpportunity,
  evidenceReevaluationStateForOpportunity,
  currentEvidenceV3,
  evidenceAutomationPanelForOpportunity,
} from '@seo-agent/database';
import {
  addOwnerEvidenceAction,
  addSerpObservationAction,
  enqueueEvidenceReevaluationAction,
  dismissOpportunityAction,
  enqueueAiAnalysis,
  enqueueSourcePlan,
  refreshInternalEvidenceAction,
  type EvidenceReevaluationActionState,
  confirmReusableOwnerFactAction,
  captureSerpAction,
  confirmSerpCaptureAction,
  discardSerpCaptureAction,
  fetchSerpApiAction,
  acceptSerpApiCaptureAction,
  rejectSerpApiCaptureAction,
} from '../../actions';
import { EvidenceReevaluationControl } from './evidence-reevaluation-control';
import { RealBrowserCaptureTool } from './real-browser-capture-tool';

export const dynamic = 'force-dynamic';
export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, ai, source, evidenceRequired, evidencePacket, reevaluation, automation] =
    await Promise.all([
      opportunityDetail(id),
      aiPanelForOpportunity(id),
      sourcePanelForOpportunity(id),
      evidencePanelForOpportunity(id),
      deterministicEvidencePacket(id),
      evidenceReevaluationStateForOpportunity(id),
      evidenceAutomationPanelForOpportunity(id),
    ]);
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
      <SourceUnderstandingPanel source={source} item={item} />
      <EvidenceRequiredPanel
        evidence={evidenceRequired}
        opportunityId={id}
        query={String(item.query ?? '')}
        siteId={String(item.site_id)}
        evidencePacketHash={evidencePacket.evidencePacketHash}
        reevaluation={reevaluation}
        automation={automation}
      />
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

function EvidenceRequiredPanel({
  evidence,
  opportunityId,
  query,
  siteId,
  evidencePacketHash,
  reevaluation,
  automation,
}: {
  evidence: Awaited<ReturnType<typeof evidencePanelForOpportunity>>;
  opportunityId: string;
  query: string;
  siteId: string;
  evidencePacketHash: string;
  reevaluation: Awaited<ReturnType<typeof evidenceReevaluationStateForOpportunity>>;
  automation: Awaited<ReturnType<typeof evidenceAutomationPanelForOpportunity>>;
}) {
  const latestJob = reevaluation.latestJob as Record<string, unknown> | null;
  const latestV3 = reevaluation.latestV3 as Record<string, unknown> | null;
  const currentV3 = currentEvidenceV3(latestV3, evidencePacketHash);
  const completedEvidencePacketHash = currentV3 ? String(currentV3.evidence_packet_hash) : null;
  const initialState: EvidenceReevaluationActionState = reevaluation.activeJob
    ? {
        status: String(reevaluation.activeJob.status) as 'QUEUED' | 'RUNNING',
        jobId: String(reevaluation.activeJob.id),
        message:
          reevaluation.activeJob.status === 'RUNNING'
            ? 'Analyzing.'
            : 'Queued. Waiting for a worker.',
      }
    : latestJob?.status === 'FAILED'
      ? {
          status: 'FAILED',
          jobId: String(latestJob.id),
          message: `Failed: ${safeJobFailure(latestJob)}`,
        }
      : currentV3
        ? {
            status: 'SUCCEEDED',
            jobId: String(latestJob?.id ?? ''),
            message: 'Complete for the current evidence packet.',
          }
        : {
            status: 'IDLE',
            message:
              evidence.completeness === 'READY_FOR_REEVALUATION'
                ? 'Ready for re-evaluation.'
                : 'Resolve all required evidence before re-evaluation.',
          };
  return (
    <section className="panel section">
      <div className="eyebrow">Owner evidence · no automatic AI call</div>
      <h2>EVIDENCE REQUIRED</h2>
      <p className="hint">
        Completeness: {evidence.completeness}. Adding evidence stores an auditable fact only.
        Re-evaluation is a separate owner action.
      </p>
      <div className="actions">
        <form action={refreshInternalEvidenceAction.bind(null, opportunityId)}>
          <button>Refresh Internal Evidence</button>
        </form>
        <EvidenceReevaluationControl
          key={`${latestJob?.id ?? 'none'}-${latestJob?.status ?? 'idle'}-${reevaluation.latestV3?.run_id ?? 'none'}`}
          action={enqueueEvidenceReevaluationAction.bind(null, opportunityId, siteId)}
          initialState={initialState}
          completeness={evidence.completeness}
          workerHealthy={reevaluation.workerHealthy}
          lastHeartbeat={
            reevaluation.lastHeartbeat ? new Date(reevaluation.lastHeartbeat).toISOString() : null
          }
          currentV3={currentV3}
          historicalV3={currentV3 ? null : latestV3}
          currentEvidencePacketHash={evidencePacketHash}
          completedEvidencePacketHash={completedEvidencePacketHash}
        />
      </div>
      {!evidence.requests.length ? (
        <div className="empty compact-empty">No evidence requests for this opportunity.</div>
      ) : (
        evidence.requests.map((request) => {
          const captures = automation.captures.filter(
            (capture) => capture.request_id === request.id,
          );
          const latestCapture = captures[0] as Record<string, unknown> | undefined;
          const apiCaptures = (automation.apiCaptures ?? []).filter(
            (capture) => capture.request_id === request.id,
          );
          const latestApiCapture = apiCaptures[0] as Record<string, unknown> | undefined;
          const machine = (latestCapture?.machine_capture ?? {}) as Record<string, unknown>;
          const features = (machine.features ?? {}) as Record<string, unknown>;
          return (
            <article className="panel compact section" key={request.id}>
              <strong>
                {request.type} · {request.status}
              </strong>
              <p>{request.requirement}</p>
              <p className="hint">
                Why: {request.reason} · Source: {request.source}
              </p>
              {request.status === 'OPEN' && request.type === 'MANUAL_SERP_OBSERVATION' ? (
                <>
                  <h3>SERP Evidence</h3>
                  <p className="hint">
                    Required: City · Mobile. Fetching uses one owner-authorized internal free
                    allowance. Opening this page never consumes provider quota.
                  </p>
                  <form action={fetchSerpApiAction.bind(null, opportunityId, request.id)}>
                    <label>
                      Requested location
                      <input
                        name="requestedLocation"
                        defaultValue="Ubon Ratchathani, Thailand"
                        required
                      />
                    </label>
                    <label>
                      Device
                      <select name="device" defaultValue="MOBILE">
                        <option value="MOBILE">Mobile</option>
                        <option value="DESKTOP">Desktop</option>
                        <option value="TABLET">Tablet</option>
                      </select>
                    </label>
                    <button>Fetch SERP Evidence</button>
                  </form>
                  <h3>Automated Browser SERP capture</h3>
                  <p className="hint">
                    The query and target domain are fixed. Emulation is not a real-device
                    observation. Capture remains unconfirmed until owner review.
                  </p>
                  {!latestCapture ||
                  ['FAILED', 'CAPTURE_BLOCKED', 'DISCARDED', 'CONFIRMED'].includes(
                    String(latestCapture.status),
                  ) ? (
                    <form action={captureSerpAction.bind(null, opportunityId, request.id)}>
                      <p>
                        <strong>Query:</strong> {query}
                      </p>
                      <p>
                        <strong>Target domain:</strong> amphon.co.th
                      </p>
                      <label>
                        Device
                        <select name="deviceProvenance" defaultValue="EMULATED_DESKTOP">
                          <option value="EMULATED_DESKTOP">Emulated Desktop</option>
                          <option value="EMULATED_MOBILE">Emulated Mobile</option>
                        </select>
                      </label>
                      <label>
                        Requested location
                        <input
                          name="requestedLocationLabel"
                          defaultValue="Ubon Ratchathani"
                          required
                        />
                      </label>
                      <label>
                        Timezone
                        <input name="timezone" value="Asia/Bangkok" readOnly required />
                      </label>
                      <div className="grid">
                        <label>
                          Latitude (optional)
                          <input name="latitude" type="number" step="any" />
                        </label>
                        <label>
                          Longitude (optional)
                          <input name="longitude" type="number" step="any" />
                        </label>
                      </div>
                      <button>Run Optional Automated Capture</button>
                    </form>
                  ) : null}
                </>
              ) : null}
              {request.status === 'RESOLVED' && request.type === 'MANUAL_SERP_OBSERVATION' ? (
                <details>
                  <summary>Fetch fresh SERP API evidence</summary>
                  <p className="notice">
                    This explicit action consumes one internal free allowance. New evidence never
                    triggers AI automatically. Captures always require owner review.
                  </p>
                  <form action={fetchSerpApiAction.bind(null, opportunityId, request.id)}>
                    <input
                      type="hidden"
                      name="requestedLocation"
                      value="Ubon Ratchathani, Thailand"
                    />
                    <input type="hidden" name="device" value="MOBILE" />
                    <button>Fetch Fresh SERP Evidence · City · Mobile</button>
                  </form>
                </details>
              ) : null}
              {latestApiCapture ? (
                <section className="capture-review">
                  <h3>SERP API Capture</h3>
                  <p>
                    <strong>Provider:</strong> {String(latestApiCapture.provider ?? 'PENDING')}
                  </p>
                  <p>
                    <strong>Status:</strong>{' '}
                    {latestApiCapture.status === 'PENDING_REVIEW'
                      ? 'Captured — Review Required'
                      : String(latestApiCapture.status)}
                  </p>
                  <p>
                    <strong>Review policy:</strong> {String(latestApiCapture.review_policy)}
                  </p>
                  <p>
                    <strong>Query:</strong> {String(latestApiCapture.query)}
                  </p>
                  <p>
                    <strong>Requested location:</strong>{' '}
                    {String(latestApiCapture.requested_location)}
                  </p>
                  <p>
                    <strong>Provider location used:</strong>{' '}
                    {String(latestApiCapture.provider_location_used ?? 'UNKNOWN')}
                  </p>
                  <p>
                    <strong>Precision:</strong>{' '}
                    {String(
                      latestApiCapture.location_precision ?? latestApiCapture.required_precision,
                    )}
                  </p>
                  <p>
                    <strong>Device:</strong> {String(latestApiCapture.device)}
                  </p>
                  <p>
                    <strong>AMPHON position:</strong>{' '}
                    {String(latestApiCapture.target_organic_position ?? 'NOT FOUND / UNKNOWN')}
                  </p>
                  <p>
                    <strong>URL:</strong> {String(latestApiCapture.target_url ?? '—')}
                  </p>
                  <p>
                    <strong>Title:</strong> {String(latestApiCapture.target_title ?? '—')}
                  </p>
                  <p>
                    <strong>Snippet:</strong> {String(latestApiCapture.target_snippet ?? '—')}
                  </p>
                  <p>
                    <strong>Features:</strong>
                  </p>
                  <pre>
                    {JSON.stringify(
                      ((latestApiCapture.normalized_result as Record<string, unknown> | null)
                        ?.features as Record<string, unknown> | undefined) ?? {},
                      null,
                      2,
                    )}
                  </pre>
                  {latestApiCapture.conflict ? (
                    <div className="notice danger-text">
                      SERP_OBSERVATION_CONFLICT — owner and API observations are both preserved.
                    </div>
                  ) : null}
                  {latestApiCapture.status === 'PENDING_REVIEW' ? (
                    <>
                      <form
                        action={acceptSerpApiCaptureAction.bind(
                          null,
                          opportunityId,
                          String(latestApiCapture.id),
                        )}
                      >
                        <button>Accept Evidence</button>
                      </form>
                      <form
                        action={rejectSerpApiCaptureAction.bind(
                          null,
                          opportunityId,
                          String(latestApiCapture.id),
                        )}
                      >
                        <button className="danger">Reject</button>
                      </form>
                    </>
                  ) : null}
                  <p>
                    <a href={`#real-browser-capture-${request.id}`}>Use Real Browser Instead</a>
                  </p>
                </section>
              ) : null}
              {request.type === 'MANUAL_SERP_OBSERVATION' &&
              (request.status === 'OPEN' || latestCapture?.status === 'CAPTURE_BLOCKED') ? (
                <div id={`real-browser-capture-${request.id}`}>
                  <RealBrowserCaptureTool
                    opportunityId={opportunityId}
                    requestId={request.id}
                    query={query}
                  />
                </div>
              ) : null}
              {request.status === 'RESOLVED' &&
              request.type === 'MANUAL_SERP_OBSERVATION' &&
              (!latestCapture ||
                ['CONFIRMED', 'DISCARDED', 'FAILED', 'CAPTURE_BLOCKED'].includes(
                  String(latestCapture.status),
                )) ? (
                <details>
                  <summary>Add another SERP observation</summary>
                  <p className="notice">
                    Adding and confirming another observation changes evidence identity and may mark
                    the current V3 plan STALE. It never starts reevaluation.
                  </p>
                  <form action={captureSerpAction.bind(null, opportunityId, request.id)}>
                    <input type="hidden" name="requestedLocationLabel" value="Ubon Ratchathani" />
                    <input type="hidden" name="timezone" value="Asia/Bangkok" />
                    <label>
                      Device
                      <select name="deviceProvenance" defaultValue="EMULATED_DESKTOP">
                        <option value="EMULATED_DESKTOP">Emulated Desktop</option>
                        <option value="EMULATED_MOBILE">Emulated Mobile</option>
                      </select>
                    </label>
                    <button>Capture another SERP</button>
                  </form>
                </details>
              ) : null}
              {latestCapture && ['QUEUED', 'CAPTURING'].includes(String(latestCapture.status)) ? (
                <div className="notice">SERP capture: {String(latestCapture.status)}</div>
              ) : null}
              {latestCapture?.status === 'CAPTURE_BLOCKED' ? (
                <div className="notice danger-text">
                  <p>Automated Google capture was blocked.</p>
                  <p>Google challenged automated capture. Use Real Browser Capture instead.</p>
                  <p>
                    <a href={`#real-browser-capture-${request.id}`}>Use Real Browser Capture</a> ·{' '}
                    <a href={`#manual-observation-${request.id}`}>Enter Observation Manually</a>
                  </p>
                </div>
              ) : null}
              {latestCapture?.status === 'CAPTURED' ? (
                <section className="capture-review">
                  <h3>
                    {machine.provenance === 'OWNER_ASSISTED_BROWSER_CAPTURE'
                      ? 'OWNER-ASSISTED SERP CAPTURE'
                      : 'SERP Capture'}{' '}
                    · awaiting owner confirmation
                  </h3>
                  <p>
                    <strong>Query:</strong> {String(latestCapture.query)}
                  </p>
                  <p className="hint">
                    Captured {new Date(String(latestCapture.captured_at)).toLocaleString()} ·{' '}
                    {String(latestCapture.timezone)} ·{' '}
                    {latestCapture.device_provenance === 'REAL_DESKTOP_BROWSER'
                      ? 'Real Desktop'
                      : latestCapture.device_provenance === 'REAL_MOBILE_BROWSER'
                        ? 'Real Mobile'
                        : String(latestCapture.device_provenance)}
                  </p>
                  <p>
                    <strong>Owner-declared location:</strong>{' '}
                    {String(latestCapture.requested_location_label)}
                  </p>
                  <p>
                    <strong>Google displayed location:</strong>{' '}
                    {String(latestCapture.google_displayed_location ?? 'UNKNOWN')}
                  </p>
                  {latestCapture.screenshot_path ? (
                    <p>
                      <a
                        href={`/api/serp-captures/${latestCapture.id}/screenshot`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View screenshot
                      </a>{' '}
                      · SHA256 {String(latestCapture.screenshot_sha256).slice(0, 12)}…
                    </p>
                  ) : null}
                  <p>
                    <strong>AMPHON organic position:</strong>{' '}
                    {machine.approximateOrganicPosition == null
                      ? 'UNKNOWN'
                      : String(machine.approximateOrganicPosition)}
                  </p>
                  {Array.isArray(machine.lowConfidenceFields) &&
                  machine.lowConfidenceFields.length ? (
                    <div className="notice">
                      Low confidence: {machine.lowConfidenceFields.join(', ')}
                    </div>
                  ) : null}
                  <h4>Correct Fields</h4>
                  <form
                    action={confirmSerpCaptureAction.bind(
                      null,
                      opportunityId,
                      String(latestCapture.id),
                    )}
                  >
                    <label>
                      Displayed title
                      <input
                        name="displayedTitle"
                        defaultValue={String(machine.displayedTitle ?? '')}
                        required
                      />
                    </label>
                    <label>
                      Displayed snippet
                      <textarea
                        name="displayedSnippet"
                        defaultValue={String(machine.displayedSnippet ?? '')}
                        required
                      />
                    </label>
                    <label>
                      Ranking URL
                      <input
                        name="rankingUrl"
                        type="url"
                        defaultValue={String(machine.resolvedLandingUrl ?? '')}
                        required
                      />
                    </label>
                    <label>
                      Approximate organic position
                      <input
                        name="approximateOrganicPosition"
                        type="number"
                        min="1"
                        defaultValue={
                          machine.approximateOrganicPosition == null
                            ? ''
                            : String(machine.approximateOrganicPosition)
                        }
                      />
                    </label>
                    <label>
                      SERP features
                      <input
                        name="serpFeatures"
                        defaultValue={Object.entries(features)
                          .filter(([, value]) => value === 'PRESENT')
                          .map(([key]) => key)
                          .join(', ')}
                      />
                    </label>
                    <p className="hint">
                      Corrections retain both machine-captured and owner-confirmed values.
                    </p>
                    <button>Confirm Observation</button>
                  </form>
                  <form
                    action={discardSerpCaptureAction.bind(
                      null,
                      opportunityId,
                      String(latestCapture.id),
                    )}
                  >
                    <button className="danger">Discard</button>
                  </form>
                </section>
              ) : null}
              {request.status === 'OPEN' && request.type === 'MANUAL_SERP_OBSERVATION' ? (
                <details id={`manual-observation-${request.id}`}>
                  <summary>Use manual real-device observation instead</summary>
                  <form action={addSerpObservationAction.bind(null, opportunityId, request.id)}>
                    <input type="hidden" name="query" value={query} />
                    <label>
                      Observed at
                      <input name="observedAt" type="datetime-local" required />
                    </label>
                    <label>
                      Timezone
                      <input name="observedTimezone" value="Asia/Bangkok" readOnly required />
                    </label>
                    <input name="location" placeholder="Location" required />
                    <input name="device" placeholder="Device" required />
                    <input name="displayedTitle" placeholder="Displayed title" required />
                    <textarea name="displayedSnippet" placeholder="Displayed snippet" required />
                    <input name="rankingUrl" type="url" placeholder="Ranking URL" required />
                    <input
                      name="approximatePosition"
                      type="number"
                      min="1"
                      placeholder="Approx. position"
                    />
                    <input name="serpFeatures" placeholder="SERP features, comma-separated" />
                    <textarea name="notes" placeholder="Notes" />
                    <button>Add SERP Observation</button>
                  </form>
                </details>
              ) : null}
              {request.status === 'OPEN' &&
              request.type === 'OWNER_BUSINESS_CONFIRMATION' &&
              automation.facts.requirements.length ? (
                <section>
                  <h3>Business facts required</h3>
                  <p className="hint">
                    {automation.facts.requirements.filter((item) => item.match).length} reusable
                    facts found ·{' '}
                    {automation.facts.requirements.filter((item) => !item.match).length} owner
                    confirmations required
                  </p>
                  {automation.facts.requirements.map((state) => (
                    <div className="fact-row" key={state.requirement.factKey}>
                      <div>
                        <strong>
                          {state.match ? '✓' : state.conflict || state.expired ? '!' : '○'}{' '}
                          {state.requirement.label}
                        </strong>
                        <p className="hint">
                          {state.match
                            ? 'Confirmed previously · OWNER_CONFIRMED_REUSED'
                            : state.conflict
                              ? 'Conflicting active facts require owner review'
                              : state.expired
                                ? 'Needs owner reconfirmation'
                                : `Missing · ${state.requirement.scopeType}:${state.requirement.scopeKey}`}
                        </p>
                      </div>
                      {!state.match && !state.conflict ? (
                        <form
                          action={confirmReusableOwnerFactAction.bind(
                            null,
                            opportunityId,
                            request.id,
                            state.requirement.factKey,
                          )}
                        >
                          <button>Confirm fact</button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null}
              {request.status === 'RESOLVED' &&
              request.type === 'OWNER_BUSINESS_CONFIRMATION' &&
              automation.facts.complete ? (
                <div className="notice">
                  Resolved automatically from {automation.facts.requirements.length} reusable owner
                  facts. Original owner provenance retained.
                </div>
              ) : null}
              {request.status === 'OPEN' &&
              request.type.startsWith('OWNER_') &&
              (request.type !== 'OWNER_BUSINESS_CONFIRMATION' ||
                automation.facts.requirements.length === 0) ? (
                <form action={addOwnerEvidenceAction.bind(null, opportunityId, request.id)}>
                  <textarea name="statement" placeholder="Fact or ownership statement" required />
                  <input name="confirmation" placeholder="Confirmed value" required />
                  <input name="scope" placeholder="Opportunity-specific scope" required />
                  <textarea name="notes" placeholder="Notes" />
                  <button>
                    {request.type === 'OWNER_QUERY_OWNERSHIP'
                      ? 'Confirm Query Ownership'
                      : 'Confirm Business Fact'}
                  </button>
                </form>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}

function safeJobFailure(job: Record<string, unknown>) {
  const code = String(job.failure_code ?? '');
  if (code === 'AI_BUDGET_EXCEEDED') return 'AI budget exceeded.';
  if (code === 'EVIDENCE_INCOMPLETE') return 'Required evidence is incomplete.';
  if (code === 'AI_PROVIDER_ERROR') return 'The provider request failed.';
  if (code === 'AI_AUTH_ERROR') return 'The AI provider is not configured correctly.';
  if (code === 'AI_RATE_LIMITED') return 'The AI provider is temporarily rate limited.';
  if (code === 'WORKER_LOST') return 'The worker stopped before completing the job.';
  return 'Re-evaluation did not complete. Review worker health and try again deliberately.';
}

function SourceUnderstandingPanel({
  source,
  item,
}: {
  source: Awaited<ReturnType<typeof sourcePanelForOpportunity>>;
  item: Record<string, unknown>;
}) {
  const plan = source.latest;
  const output = (plan?.structured_output ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(output.source_findings)
    ? (output.source_findings as Array<Record<string, unknown>>)
    : [];
  const changes = Array.isArray(output.change_items)
    ? (output.change_items as Array<Record<string, unknown>>)
    : [];
  const context = (plan?.source_context ?? {}) as Record<string, unknown>;
  const sourceFiles = Array.isArray(context.files)
    ? (context.files as Array<Record<string, unknown>>)
    : [];
  return (
    <section className="panel section">
      <div className="heading small">
        <div>
          <div className="eyebrow">Read-only evidence</div>
          <h2>Source Understanding</h2>
          <p className="hint">
            Mapping: {String(source.mapping?.route_path ?? 'Not mapped')} →{' '}
            {String(source.mapping?.primary_source_path ?? 'Source mapping required')} · HEAD{' '}
            {String(source.mapping?.head_sha ?? '—').slice(0, 8)} · Status{' '}
            {String(source.mapping?.mapping_status ?? 'NOT_REFRESHED')}
          </p>
        </div>
        {source.mapping && !source.activeJob ? (
          <form action={enqueueSourcePlan.bind(null, String(item.id), String(item.site_id))}>
            <button
              disabled={!source.configured || !['OPEN', 'MONITOR'].includes(String(item.status))}
            >
              Generate Source Plan
            </button>
          </form>
        ) : source.activeJob ? (
          <button disabled>{source.activeJob.status}</button>
        ) : null}
      </div>
      {!plan ? (
        <div className="empty compact-empty">No source-aware change plan has been generated.</div>
      ) : (
        <>
          <div className="stats four">
            <Stat label="Verdict" value={plan.verdict} />
            <Stat label="Confidence" value={plan.confidence} />
            <Stat label="Batch 5" value={plan.batch5_reconciliation} />
            <Stat label="Status" value={plan.status} />
          </div>
          <p>{plan.summary}</p>
          <h2>Supplied source ranges</h2>
          {sourceFiles.map((file, fileIndex) => {
            const excerpts = Array.isArray(file.excerpts)
              ? (file.excerpts as Array<Record<string, unknown>>)
              : [];
            return excerpts.map((excerpt, excerptIndex) => (
              <p className="hint" key={`${fileIndex}-${excerptIndex}`}>
                {String(file.path)} lines {String(excerpt.startLine)}–
                {String(excerpt.actualEndLine ?? excerpt.endLine)} ·{' '}
                {String(excerpt.actualCharacters ?? String(excerpt.text ?? '').length)} characters
              </p>
            ));
          })}
          <h2>Source findings</h2>
          {findings.map((finding, index) => (
            <p key={index}>
              <strong>
                {String(finding.path)} lines {String(finding.start_line)}–{String(finding.end_line)}
                :
              </strong>{' '}
              {String(finding.finding)}
            </p>
          ))}
          <h2>Change plan</h2>
          {changes.map((change, index) => (
            <article key={index} className="panel compact section">
              <strong>
                {String(change.change_type)} · {String(change.path)} lines{' '}
                {String(change.start_line)}–{String(change.end_line)}
              </strong>
              <p>{String(change.proposed_change)}</p>
              <p className="hint">
                Current: {String(change.current_state)} · Reason: {String(change.reason)} · Risk:{' '}
                {String(change.risk)}
              </p>
            </article>
          ))}
          <p className="hint">
            Approval records intent only and never writes to the source repository or website. Cost
            ${(Number(plan.actual_cost_micros ?? 0) / 1_000_000).toFixed(4)}
          </p>
        </>
      )}
    </section>
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
