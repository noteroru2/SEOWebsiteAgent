import { listJobs } from '@seo-agent/database';
import { formatThaiDateTime, getThaiJobStatus, getThaiJobType } from '@seo-agent/shared';
import { enqueueSystemTest } from '../actions';

export const dynamic = 'force-dynamic';
export default async function Jobs() {
  const data: Awaited<ReturnType<typeof listJobs>> = await listJobs().catch(() => ({
    rows: [],
    timingMs: 0,
  }));
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">การประมวลผลพื้นหลัง</div>
          <h1>งานของระบบ</h1>
          <p className="muted">ประวัติการประมวลผลและสถานะคิวงานของ SEO Agent</p>
        </div>
        <form action={enqueueSystemTest}>
          <button type="submit" className="button secondary">ทดสอบระบบ</button>
        </form>
      </div>
      <section className="panel">
        {data.rows.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>ประเภทงาน</th>
                  <th>สถานะ</th>
                  <th>จำนวนครั้งที่ลอง</th>
                  <th>เวลาเริ่มทำงาน</th>
                  <th>รายละเอียดข้อผิดพลาด</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <strong>{getThaiJobType(job.type)}</strong>
                      <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{job.type}</div>
                    </td>
                    <td>
                      <span className="pill">{getThaiJobStatus(job.status)}</span>
                    </td>
                    <td>
                      {job.attemptCount}/{job.maxAttempts}
                    </td>
                    <td>{formatThaiDateTime(job.startedAt)}</td>
                    <td>{job.failureSummary ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">ยังไม่มีประวัติการทำงานในคิว</div>
        )}
        <div className="timing">ความเร็วคิวรี {data.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
