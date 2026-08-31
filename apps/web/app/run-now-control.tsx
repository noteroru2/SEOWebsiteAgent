'use client';

import { useEffect, useState } from 'react';

type RunResult = {
  runId: string;
  requested: number;
  eligible: number;
  enqueued: number;
  alreadyQueued: number;
  alreadyRunning: number;
  alreadyCompletedToday: number;
  skipped: Array<{ siteName: string; reason: string }>;
};

type Status = {
  counts: { queued: number; running: number; completed: number; failed: number; cancelled: number };
  lastUpdate: string;
};

export function RunNowControl({
  siteId,
  disabledReason,
  eligibleCount,
  compact = false,
}: {
  siteId?: string;
  disabledReason?: string | null;
  eligibleCount?: number;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!result?.runId) return;
    let active = true;
    const poll = async () => {
      const response = await fetch(`/api/jobs/run-now?runId=${encodeURIComponent(result.runId)}`, {
        cache: 'no-store',
      });
      if (!active || !response.ok) return;
      const next = (await response.json()) as Status;
      setStatus(next);
      if (next.counts.queued + next.counts.running === 0) return;
      window.setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      active = false;
    };
  }, [result?.runId]);

  async function runNow() {
    const message = siteId
      ? 'เริ่มตรวจเว็บไซต์นี้ทันที?'
      : `เริ่มตรวจ SEO ทุกเว็บไซต์ที่พร้อมใช้งานตอนนี้${eligibleCount !== undefined ? ` (${eligibleCount} เว็บไซต์)` : ''}?`;
    if (!window.confirm(message)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/jobs/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(siteId ? { mode: 'SITE', siteId } : { mode: 'ALL' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(String(body.code ?? 'REQUEST_FAILED'));
      setResult(body as RunResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'REQUEST_FAILED');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || Boolean(disabledReason);
  return (
    <div className={compact ? 'command-control compact-control' : 'command-control'}>
      <button type="button" onClick={runNow} disabled={disabled}>
        {busy ? 'กำลังเตรียมงาน…' : siteId ? 'ตรวจเว็บไซต์นี้ทันที' : 'ทำงานทันที'}
      </button>
      {disabledReason ? <span className="hint command-reason">{disabledReason}</span> : null}
      {error ? <div className="notice danger-text">ไม่สามารถเริ่มงานได้: {error}</div> : null}
      {result ? (
        <div className="command-result" data-testid="manual-run-result">
          <strong>Run ID: {result.runId}</strong>
          <span>
            ขอ {result.requested} · พร้อม {result.eligible} · เข้าคิว {result.enqueued} · มีอยู่แล้ว{' '}
            {result.alreadyQueued + result.alreadyRunning} · สำเร็จแล้ววันนี้{' '}
            {result.alreadyCompletedToday} · ข้าม {result.skipped.length}
          </span>
          {status ? (
            <>
              <span>
                รอ {status.counts.queued} · ทำงาน {status.counts.running} · สำเร็จ{' '}
                {status.counts.completed} · ไม่สำเร็จ {status.counts.failed}
              </span>
              <span>อัปเดตล่าสุด {new Date(status.lastUpdate).toLocaleTimeString('th-TH')}</span>
            </>
          ) : (
            <span>Preparing / Queued</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
