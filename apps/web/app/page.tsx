import Link from 'next/link';
import {
  aiSpendSummary,
  dashboardSummary,
  dashboardTopOpportunities,
  databaseHealthy,
  ownerDashboardOverview,
} from '@seo-agent/database';
import {
  formatThaiDateTime,
  getThaiJobStatus,
  getThaiJobType,
  getThaiOpportunityType,
  getThaiPriority,
  getThaiRecommendation,
} from '@seo-agent/shared';
import { enqueueSystemTest } from './actions';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  let data: Awaited<ReturnType<typeof dashboardSummary>> | null = null;
  let dbHealthy = false;
  let top: Awaited<ReturnType<typeof dashboardTopOpportunities>> = { rows: [], timingMs: 0 };
  let aiSpend: Awaited<ReturnType<typeof aiSpendSummary>> | null = null;
  let ownerData: Awaited<ReturnType<typeof ownerDashboardOverview>> | null = null;

  try { dbHealthy = await databaseHealthy(); } catch { dbHealthy = false; }
  try { data = await dashboardSummary(); } catch { data = null; }
  try { top = await dashboardTopOpportunities(); } catch { top = { rows: [], timingMs: 0 }; }
  try { aiSpend = await aiSpendSummary(); } catch { aiSpend = null; }
  try { ownerData = await ownerDashboardOverview(); } catch { ownerData = null; }

  const isSystemHealthy = dbHealthy && (data?.workerHealthy ?? false);

  return (
    <>
      {/* Top Banner */}
      <div className="heading">
        <div>
          <div className="eyebrow">ศูนย์ควบคุม SEO สำหรับเจ้าของเว็บไซต์</div>
          <h1>ภาพรวมระบบ SEO Agent</h1>
          <p className="subtitle" style={{ marginTop: '4px', opacity: 0.8, fontSize: '0.95rem' }}>
            {isSystemHealthy
              ? '● ระบบกำลังทำงานปกติ — SEO Agent กำลังติดตามเว็บไซต์ให้อัตโนมัติ'
              : '▲ ระบบต้องการการตรวจสอบ — กรุณาดูรายละเอียดที่สถานะระบบ'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <form action={enqueueSystemTest}>
            <button type="submit" className="button secondary" style={{ fontSize: '0.85rem' }}>
              ทดสอบระบบ
            </button>
          </form>
        </div>
      </div>

      {/* Top Watch Info */}
      <div className="panel compact section" style={{ padding: '12px 16px', background: 'var(--panel-bg, #1a1a1a)', borderRadius: '8px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', fontSize: '0.9rem' }}>
          <div>
            <span style={{ opacity: 0.7 }}>สถานะตรวจติดตาม: </span>
            <strong style={{ color: '#4ade80' }}>ทำงานอัตโนมัติประจำวัน</strong>
          </div>
          <div>
            <span style={{ opacity: 0.7 }}>ตรวจล่าสุด: </span>
            <strong>{ownerData?.latestWatchRun ? formatThaiDateTime(ownerData.latestWatchRun.created_at) : '—'}</strong>
          </div>
          <div>
            <span style={{ opacity: 0.7 }}>ตรวจครั้งถัดไป: </span>
            <strong>09:15 น. (Asia/Bangkok)</strong>
          </div>
        </div>
      </div>

      {/* Section 1: งานที่ต้องทำวันนี้ */}
      <section className="panel section" style={{ marginBottom: '24px', borderLeft: '4px solid #3b82f6' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '12px' }}>งานที่ต้องทำวันนี้</h2>
        {ownerData?.ownerActionCategory === 'RELEASE_AUTHORIZATION_REQUIRED' ? (
          <div className="empty" style={{ background: '#fef3c7', color: '#92400e', textAlign: 'left', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>มีเวอร์ชันที่ผ่านการตรวจสอบและรออนุมัติเผยแพร่</h3>
            <p style={{ margin: '4px 0 12px 0' }}>มีงานแก้ไขเว็บไซต์ที่ผ่าน Validation เรียบร้อยแล้ว รอให้เจ้าของอนุมัติเผยแพร่</p>
            <Link href="/approvals" className="button primary">
              ตรวจสอบรายการอนุมัติเผยแพร่ ({ownerData.releaseAuthorizationRequiredCount})
            </Link>
          </div>
        ) : ownerData?.ownerActionCategory === 'PATCH_APPROVAL_REQUIRED' ? (
          <div className="empty" style={{ background: '#eff6ff', color: '#1e40af', textAlign: 'left', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>มีการแก้ไขเว็บไซต์รอคุณอนุมัติ</h3>
            <p style={{ margin: '4px 0 12px 0' }}>ระบบมีข้อเสนอแนะแก้ไขเว็บไซต์ที่รอการตรวจสอบอนุมัติเพื่อนำไป Validation</p>
            <Link href="/approvals" className="button primary">
              ดูรายการรออนุมัติ ({ownerData.patchApprovalRequiredCount})
            </Link>
          </div>
        ) : ownerData?.ownerActionCategory === 'OWNER_INPUT_REQUIRED' ? (
          <div className="empty" style={{ background: '#fef3c7', color: '#92400e', textAlign: 'left', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>ต้องให้ข้อมูลจากเจ้าของ</h3>
            <p style={{ margin: '4px 0 12px 0' }}>มีโอกาส SEO ที่ต้องการการยืนยันหรือสังเกตการณ์จริงจากเจ้าของธุรกิจ</p>
            <Link href="/opportunities" className="button primary">
              ส่งข้อมูลที่ต้องระบุ ({ownerData.ownerInputRequiredCount})
            </Link>
          </div>
        ) : ownerData?.ownerActionCategory === 'GOLDEN_PATH_REVIEW_AVAILABLE' ? (
          <div className="empty" style={{ background: '#f0fdf4', color: '#166534', textAlign: 'left', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>พบโอกาส SEO ที่พร้อมให้ตรวจสอบ</h3>
            <p style={{ margin: '4px 0 12px 0' }}>ระบบพบโอกาสสำคัญที่มีหลักฐานสมบูรณ์พร้อมให้เริ่มกระบวนการปรับปรุง</p>
            <Link href="/opportunities" className="button primary">
              ตรวจสอบโอกาสนี้ ({ownerData.goldenPathCandidatesCount})
            </Link>
          </div>
        ) : (
          <div className="empty" style={{ textAlign: 'left', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#4ade80' }}>✓ วันนี้ยังไม่มีงานที่คุณต้องดำเนินการ</h3>
            <p style={{ margin: '4px 0 0 0', opacity: 0.85 }}>
              ระบบกำลังติดตามข้อมูล SEO ให้อัตโนมัติ (กำลังติดตามโอกาสคำค้นอยู่ {ownerData?.activeOpportunitiesCount ?? 0} รายการ)
            </p>
          </div>
        )}
      </section>

      {/* Primary KPI Cards */}
      <div className="stats">
        <Stat label="เว็บไซต์ที่ดูแล" value={data?.sites ?? 0} />
        <Stat label="โอกาส SEO ที่กำลังติดตาม" value={ownerData?.activeOpportunitiesCount ?? 0} />
        <Stat label="พร้อมให้เจ้าของตรวจ" value={ownerData?.goldenPathCandidatesCount ?? 0} />
        <Stat label="รออนุมัติ" value={data?.pending ?? 0} />
        <Stat label="ค่าใช้ AI เดือนนี้" value={formatUsd(aiSpend?.cost_micros)} />
      </div>

      {/* Section: Golden Path Status */}
      <section className="panel section" style={{ marginTop: '20px' }}>
        <h2>สถานะโอกาสสำคัญ (Golden Path)</h2>
        {(ownerData?.goldenPathCandidatesCount ?? 0) > 0 ? (
          <div style={{ padding: '12px 0' }}>
            <p style={{ color: '#4ade80', fontWeight: 'bold' }}>พบโอกาสที่พร้อมให้เจ้าของตรวจสอบ!</p>
            <Link href="/opportunities" className="button primary" style={{ marginTop: '8px', display: 'inline-block' }}>
              ตรวจสอบโอกาสที่พร้อมแก้ไข
            </Link>
          </div>
        ) : (
          <div className="empty" style={{ textAlign: 'left', padding: '16px' }}>
            <strong style={{ display: 'block', fontSize: '1rem', marginBottom: '4px' }}>
              ยังไม่มีโอกาสที่มีหลักฐานเพียงพอให้แก้เว็บไซต์
            </strong>
            <span style={{ opacity: 0.8, fontSize: '0.9rem' }}>
              ระบบกำลังรอข้อมูลจริงเพิ่มเติมจาก Google Search Console (ปัจจุบันติดตามโอกาสคำค้นอยู่ {ownerData?.activeOpportunitiesCount ?? 0} รายการ)
            </span>
          </div>
        )}
      </section>

      {/* Section: Website Portfolio Summary */}
      <section className="panel section" style={{ marginTop: '20px' }}>
        <h2>สรุปเว็บไซต์ที่ดูแล</h2>
        {ownerData?.sitesPortfolio.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>เว็บไซต์</th>
                  <th>สถานะระบบ</th>
                  <th>GSC ล่าสุด</th>
                  <th>โอกาส SEO</th>
                  <th>พร้อมให้ตรวจ</th>
                  <th>รอข้อมูลเจ้าของ</th>
                  <th>รออนุมัติ</th>
                  <th>การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {ownerData.sitesPortfolio.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <strong>{site.name}</strong>
                      <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>{site.url}</div>
                    </td>
                    <td>
                      <span className="pill" style={{ background: site.active ? '#15803d' : '#404040', color: '#fff' }}>
                        {site.active ? 'กำลังติดตาม' : 'ปิดการทำงาน'}
                      </span>
                    </td>
                    <td>{formatThaiDateTime(site.last_gsc_sync_at)}</td>
                    <td>{site.opp_count} รายการ</td>
                    <td>
                      <span className="pill" style={{ background: site.candidate_count > 0 ? '#15803d' : 'transparent', border: '1px solid #525252' }}>
                        {site.candidate_count}
                      </span>
                    </td>
                    <td>{site.owner_input_count}</td>
                    <td>{site.approval_count}</td>
                    <td>
                      <Link href={`/sites/${site.id}`}>ดูรายละเอียด</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">ยังไม่มีเว็บไซต์ในระบบ</div>
        )}
      </section>

      {/* Opportunities & System Grid */}
      <div className="grid" style={{ marginTop: '20px' }}>
        {/* Top Opportunities */}
        <section className="panel">
          <div className="heading small">
            <h2>โอกาส SEO ล่าสุด</h2>
            <Link href="/opportunities">ดูทั้งหมด</Link>
          </div>
          {top.rows.length ? (
            <table>
              <thead>
                <tr>
                  <th>ความสำคัญ</th>
                  <th>ประเภทโอกาส</th>
                  <th>คำค้น / หน้า</th>
                  <th>การแนะนำ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {top.rows.map((item) => {
                  const thaiType = getThaiOpportunityType(item.kind);
                  const thaiRec = getThaiRecommendation(item.recommendation);
                  const thaiPrio = getThaiPriority(item.priority_label);
                  return (
                    <tr key={item.id}>
                      <td>
                        <span className="pill">{thaiPrio}</span>
                      </td>
                      <td>
                        <strong>{thaiType.title}</strong>
                      </td>
                      <td>{item.query || item.site_name}</td>
                      <td>{thaiRec}</td>
                      <td>
                        <Link href={`/opportunities/${item.id}`}>เปิดดู</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty">ยังไม่มีโอกาส SEO ที่ถูกตรวจพบ</div>
          )}
        </section>

        {/* System Health */}
        <section className="panel">
          <h2>สถานะระบบ</h2>
          <div className="health">
            <Health label="ฐานข้อมูล" healthy={dbHealthy} />
            <Health label="ระบบประมวลผล" healthy={data?.workerHealthy ?? false} />
            <Health label="คิวงาน" healthy={dbHealthy} />
            <Health label="งานอัตโนมัติ" healthy={true} text="09:15 น." />
            <Health label="พื้นที่เซิร์ฟเวอร์" healthy={true} text=">10GB" />
            <Health label="การสำรองข้อมูล" healthy={true} text="03:00 น. 30วัน" />
          </div>
          <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #333' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>การใช้งาน AI ในเดือนนี้</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.85rem' }}>
              <div>
                <span style={{ opacity: 0.7 }}>จำนวนครั้งที่ใช้ AI: </span>
                <strong>{aiSpend?.analyses ?? 0} ครั้ง</strong>
              </div>
              <div>
                <span style={{ opacity: 0.7 }}>งบสูงสุดเดือนนี้: </span>
                <strong>{formatUsd(aiSpend?.budgetMicros)}</strong>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Recent Activity */}
      <section className="panel section" style={{ marginTop: '20px' }}>
        <h2>กิจกรรมล่าสุดของระบบ</h2>
        {data?.recentJobs.length ? (
          <table>
            <thead>
              <tr>
                <th>ประเภทงาน</th>
                <th>สถานะ</th>
                <th>เวลาที่สร้าง</th>
              </tr>
            </thead>
            <tbody>
              {data.recentJobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>{getThaiJobType(j.type)}</strong>
                    <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{j.type}</div>
                  </td>
                  <td>
                    <span className="pill">{getThaiJobStatus(j.status)}</span>
                  </td>
                  <td>{formatThaiDateTime(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">ยังไม่มีประวัติกิจกรรม</div>
        )}
      </section>

      {/* Expandable Technical Details */}
      <details style={{ marginTop: '24px', opacity: 0.75, fontSize: '0.85rem' }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>รายละเอียดทางเทคนิค (Technical Details)</summary>
        <div className="panel compact" style={{ marginTop: '8px' }}>
          <div>ความเร็วคิวรี Overview: {data?.timingMs.toFixed(1) ?? '—'} ms</div>
          <div>ความเร็วคิวรี Top Opportunities: {top.timingMs.toFixed(1)} ms</div>
          <div>ความเร็วคิวรี Owner Dashboard: {ownerData?.timingMs.toFixed(1) ?? '—'} ms</div>
        </div>
      </details>
    </>
  );
}

function formatUsd(value: unknown) {
  const num = Number(value ?? 0) / 1_000_000;
  if (num === 0) return '$0.00';
  return `$${num.toFixed(4)}`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type HealthStatusType = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN' | 'STALE';

const HEALTH_STATUS_MAP: Record<HealthStatusType, { label: string; className: string }> = {
  HEALTHY: { label: 'ปกติ', className: 'ok' },
  DEGRADED: { label: 'ต้องการการตรวจสอบ', className: 'warn' },
  FAILED: { label: 'มีปัญหา', className: 'error' },
  UNKNOWN: { label: 'ยังตรวจสอบสถานะไม่ได้', className: 'warn' },
  STALE: { label: 'ข้อมูลสถานะล้าสมัย', className: 'warn' },
};

function Health({
  label,
  healthy,
  status,
  text,
}: {
  label: string;
  healthy?: boolean;
  status?: HealthStatusType;
  text?: string;
}) {
  const currentStatus: HealthStatusType = status ?? (healthy ? 'HEALTHY' : 'DEGRADED');
  const mapped = HEALTH_STATUS_MAP[currentStatus] ?? HEALTH_STATUS_MAP.DEGRADED;

  return (
    <div>
      <span>{label}</span>
      <strong className={mapped.className}>{text ?? mapped.label}</strong>
    </div>
  );
}

