import Link from 'next/link';
import { getDatabase, listPatchWorkflows, listSourceApprovals } from '@seo-agent/database';
import { formatThaiDateTime } from '@seo-agent/shared';
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
          <div className="eyebrow">ศูนย์ควบคุมการอนุมัติสำหรับเจ้าของ (Owner Control Center)</div>
          <h1>รายการรออนุมัติและการเผยแพร่</h1>
          <p className="muted">
            การกำกับการปรับปรุงเว็บไซต์ ตรวจสอบหลักฐาน ผลการ Validation การอนุมัติเผยแพร่ และการย้อนกลับ
          </p>
        </div>
      </div>

      <section className="panel section" style={{ marginBottom: '24px', borderLeft: '4px solid #f59e0b', padding: '16px', background: '#fffbeb', color: '#78350f', borderRadius: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 'bold' }}>คำอธิบายขั้นตอนการอนุมัติเพื่อความปลอดภัย:</h3>
        <ul style={{ margin: '8px 0 0 20px', padding: 0, fontSize: '0.9rem', lineHeight: '1.5' }}>
          <li><strong>ขั้นที่ 1 (ตรวจการแก้ไข):</strong> เจ้าของตรวจสอบข้อเสนอแนะและ Diff การแก้ไข</li>
          <li><strong>ขั้นที่ 2 (อนุมัติให้นำไป Validation):</strong> การอนุมัติขั้นนี้<u>ยังไม่เผยแพร่เว็บไซต์</u> แต่เป็นการสั่งให้ระบบทดสอบแก้ไขในสภาพแวดล้อมจำลอง (Staging/Build)</li>
          <li><strong>ขั้นที่ 3 (อนุมัติเผยแพร่):</strong> หลังจากการ Validation ผ่านเรียบร้อยแล้ว เจ้าของจึงค่อยพิจารณาอนุมัติให้ระบบเผยแพร่ไปยังเว็บไซต์จริง</li>
        </ul>
      </section>

      <section className="panel" style={{ marginBottom: '32px' }}>
        <h2>รายการปรับปรุงเว็บไซต์ ({workflows.rows.length})</h2>

        {workflows.rows.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>เว็บไซต์</th>
                  <th>หัวข้อ</th>
                  <th>คำค้น / เส้นทางหน้าเว็บ</th>
                  <th>ความเสี่ยง</th>
                  <th>สถานะขั้นตอน</th>
                  <th>วันที่สร้าง</th>
                  <th>การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {workflows.rows.map((wf: any) => (
                  <tr key={wf.id}>
                    <td>
                      <strong>{wf.siteName || 'เว็บไซต์ในระบบ'}</strong>
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
                        {wf.risk === 'HIGH' ? 'สูง' : wf.risk === 'MEDIUM' ? 'ปานกลาง' : 'ต่ำ'}
                      </span>
                    </td>
                    <td>
                      <span className="pill">{wf.status}</span>
                    </td>
                    <td>{formatThaiDateTime(wf.createdAt)}</td>
                    <td>
                      <Link
                        href={`/approvals/${wf.id}`}
                        className="button primary"
                        style={{
                          display: 'inline-block',
                          padding: '6px 12px',
                          fontSize: '13px',
                          textDecoration: 'none',
                        }}
                      >
                        เข้าสู่ศูนย์ควบคุม &rarr;
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty" style={{ padding: '24px', textAlign: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#4ade80' }}>✓ ยังไม่มีรายการรออนุมัติ</h3>
            <p style={{ margin: '4px 0 0 0', opacity: 0.8, fontSize: '0.9rem' }}>
              นี่เป็นสถานะปกติ ระบบกำลังติดตามข้อมูล SEO และจะแจ้งเตือนเมื่อมีข้อเสนอแนะที่พร้อมให้ตรวจสอบ
            </p>
          </div>
        )}
        <div className="timing">ความเร็วคิวรี {workflows.timingMs.toFixed(1)} ms</div>
      </section>

      {legacyPlans.rows.length > 0 && (
        <section className="panel">
          <h2>แผนการปรับปรุงโค้ดดั้งเดิม (Legacy Plans)</h2>
          <table>
            <thead>
              <tr>
                <th>เว็บไซต์</th>
                <th>โอกาส SEO</th>
                <th>สถานะ</th>
                <th>สรุป</th>
                <th>การตัดสินใจ</th>
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
                          <button className="button primary">อนุมัติแผนงาน</button>
                        </form>
                        <form action={decideSourcePlanAction.bind(null, plan.id, 'REJECTED')}>
                          <button className="button danger">ไม่อนุมัติ</button>
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
          <div className="timing">ความเร็วคิวรี {legacyPlans.timingMs.toFixed(1)} ms</div>
        </section>
      )}
    </>
  );
}
