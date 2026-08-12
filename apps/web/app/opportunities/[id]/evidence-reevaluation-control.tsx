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
  latestV3,
  currentEvidencePacketHash,
  completedEvidencePacketHash,
}: {
  action: ReevaluationAction;
  initialState: EvidenceReevaluationActionState;
  completeness: string;
  workerHealthy: boolean;
  lastHeartbeat: string | null;
  latestV3: Record<string, unknown> | null;
  currentEvidencePacketHash: string;
  completedEvidencePacketHash: string | null;
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
    active || completeness !== 'READY_FOR_REEVALUATION' || completeForCurrentEvidence;

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
      {latestV3 ? (
        <p className="hint">
          V3 result: {String(latestV3.run_status)} · Prompt {String(latestV3.prompt_version)}
          {latestV3.verdict ? ` · Verdict ${String(latestV3.verdict)}` : ''}
          {latestV3.confidence ? ` · Confidence ${String(latestV3.confidence)}` : ''}
        </p>
      ) : null}
    </div>
  );
}
