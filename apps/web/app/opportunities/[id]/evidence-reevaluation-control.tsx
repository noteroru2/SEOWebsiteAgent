'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { EvidenceReevaluationActionState } from '../../actions';

type ReevaluationAction = (
  state: EvidenceReevaluationActionState,
  formData: FormData,
) => Promise<EvidenceReevaluationActionState>;

export function EvidenceReevaluationControl({
  action,
  initialState,
  completeness,
  workerHealthy,
  lastHeartbeat,
  currentV3,
  historicalV3,
  currentEvidencePacketHash,
  completedEvidencePacketHash,
  eligible,
}: {
  action: ReevaluationAction;
  initialState: EvidenceReevaluationActionState;
  completeness: string;
  workerHealthy: boolean;
  lastHeartbeat: string | null;
  currentV3: Record<string, unknown> | null;
  historicalV3: Record<string, unknown> | null;
  currentEvidencePacketHash: string;
  completedEvidencePacketHash: string | null;
  eligible?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, initialState);
  const active = pending || ['QUEUED', 'RUNNING'].includes(state.status);
  const completeForCurrentEvidence =
    state.status === 'SUCCEEDED' && completedEvidencePacketHash === currentEvidencePacketHash;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  const visibleStatus = pending ? 'QUEUED' : state.status;
  const label =
    visibleStatus === 'RUNNING'
      ? 'Analyzing'
      : visibleStatus === 'QUEUED'
        ? 'Queued'
        : completeForCurrentEvidence
          ? 'Complete'
          : 'Re-evaluate with Evidence';
  const disabled =
    active || completeness !== 'READY_FOR_REEVALUATION' || completeForCurrentEvidence || eligible === false;

  return (
    <div>
      <form action={formAction}>
        <button disabled={disabled}>{label}</button>
      </form>
      <p className="hint" role="status" aria-live="polite">
        {pending ? 'Submitting re-evaluation request…' : state.message}
      </p>
      {active && !workerHealthy ? (
        <p className="hint" role="alert">
          Worker unavailable. The job is queued and has not started.
          {lastHeartbeat ? ` Last heartbeat: ${lastHeartbeat}.` : ''}
        </p>
      ) : null}
      {currentV3 ? (
        <p className="hint">
          V3 result: {String(currentV3.run_status)} · Prompt {String(currentV3.prompt_version)}
          {currentV3.verdict ? ` · Verdict ${String(currentV3.verdict)}` : ''}
          {currentV3.confidence ? ` · Confidence ${String(currentV3.confidence)}` : ''}
        </p>
      ) : null}
      {historicalV3 ? (
        <p className="hint">
          Historical V3: {String(historicalV3.run_status)} · Plan{' '}
          {String(historicalV3.plan_status ?? 'UNKNOWN')} · Prompt{' '}
          {String(historicalV3.prompt_version)}
          {historicalV3.verdict ? ` · Verdict ${String(historicalV3.verdict)}` : ''}
        </p>
      ) : null}
    </div>
  );
}
