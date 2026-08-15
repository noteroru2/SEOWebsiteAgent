import Link from 'next/link';
import { listDiscoveredGscProperties, listSites } from '@seo-agent/database';
import {
  formatThaiDateTime,
  getThaiSiteRole,
  getThaiSourceStatus,
  getThaiWatchMode,
} from '@seo-agent/shared';
import {
  createConfiguredSite,
  enqueueSiteCrawl,
  onboardGscPropertyAction,
  updateSitePortfolioAction,
} from '../actions';

export const dynamic = 'force-dynamic';

export default async function Sites() {
  const [data, discoveredProperties] = await Promise.all([
    listSites().catch(() => ({ rows: [], timingMs: 0 })),
    listDiscoveredGscProperties().catch(() => []),
  ]);

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">การจัดการพอร์ตโฟลิโอเว็บไซต์ (Portfolio Onboarding & Management)</div>
          <h1>พอร์ตโฟลิโอเว็บไซต์ในความดูแล</h1>
          <p className="muted">
            การเพิ่มเว็บไซต์ใหม่ การกำหนดบทบาท (Role) โหมดติดตาม (Watch Mode) และสถานะ Source
          </p>
        </div>
      </div>

      {/* Discovered GSC Properties Onboarding Panel */}
      {discoveredProperties.length > 0 && (
        <section className="panel section" style={{ marginBottom: '24px', borderLeft: '4px solid #10b981', padding: '16px', background: '#ecfdf5', borderRadius: '8px' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#065f46', marginBottom: '8px' }}>
            พบ Google Search Console Properties ในบัญชีของคุณ ({discoveredProperties.length} รายการ)
          </h2>
          <p className="hint" style={{ color: '#047857', marginBottom: '16px' }}>
            คุณสามารถเลือกนำเข้า Property เข้าสู่พอร์ตโฟลิโอ โดยระบบจะเริ่มต้นในโหมด <strong>ติดตามอย่างเดียว (MONITOR_ONLY)</strong> เพื่อความปลอดภัย
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', background: '#fff', borderRadius: '6px' }}>
              <thead>
                <tr>
                  <th>Property URI</th>
                  <th>ประเภท</th>
                  <th>สิทธิ์</th>
                  <th>สถานะพอร์ตโฟลิโอ</th>
                  <th>การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {discoveredProperties.map((prop) => {
                  const isAttached = !!prop.attached_site_id;
                  const propertyUrl = prop.property_uri.replace(/^sc-domain:/, 'https://');
                  const defaultName = prop.property_uri.replace(/^sc-domain:/, '').replace(/\/$/, '');

                  return (
                    <tr key={prop.id}>
                      <td>
                        <strong>{prop.property_uri}</strong>
                      </td>
                      <td>{prop.property_type || 'Domain / Prefix'}</td>
                      <td>{prop.permission_level}</td>
                      <td>
                        {isAttached ? (
                          <span className="pill" style={{ background: '#059669', color: '#fff' }}>
                            อยู่ในระบบ: {prop.attached_site_name} ({getThaiWatchMode(prop.attached_watch_mode)})
                          </span>
                        ) : (
                          <span className="pill" style={{ background: '#6b7280', color: '#fff' }}>
                            ยังไม่ได้นำเข้า
                          </span>
                        )}
                      </td>
                      <td>
                        {!isAttached ? (
                          <form action={onboardGscPropertyAction} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <input type="hidden" name="gscPropertyId" value={prop.id} />
                            <input type="hidden" name="name" value={defaultName} />
                            <input type="hidden" name="url" value={propertyUrl} />
                            <select name="siteRole" defaultValue="UNCLASSIFIED" style={{ fontSize: '0.8rem', padding: '4px' }}>
                              <option value="PRIMARY_NATIONAL">เว็บหลักระดับประเทศ</option>
                              <option value="NICHE_VERTICAL">เว็บเฉพาะกลุ่มสินค้า</option>
                              <option value="LOCAL_PRIMARY">เว็บหลักพื้นที่</option>
                              <option value="SUPPORTING_SITE">เว็บสนับสนุน</option>
                              <option value="EXPERIMENTAL">เว็บทดลอง</option>
                              <option value="UNCLASSIFIED">ยังไม่ได้กำหนดบทบาท</option>
                            </select>
                            <button type="submit" className="button primary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                              + นำเข้า (MONITOR_ONLY)
                            </button>
                          </form>
                        ) : (
                          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>เชื่อมต่อเรียบร้อย</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Manual Site Addition Form */}
      <section className="panel compact" style={{ marginBottom: '24px' }}>
        <h2>เพิ่มเว็บไซต์ด้วยตนเอง</h2>
        <form action={createConfiguredSite} className="site-form">
          <label>
            ชื่อเว็บไซต์
            <input name="name" minLength={2} maxLength={120} required placeholder="เช่น AMPHON" />
          </label>
          <label>
            Base URL
            <input name="url" type="url" placeholder="https://example.com/" required />
          </label>
          <label>
            จำนวนหน้าสูงสุด
            <input name="maxPages" type="number" min="1" max="5000" defaultValue="500" required />
          </label>
          <button type="submit" className="button primary">เพิ่มเว็บไซต์</button>
        </form>
      </section>

      {/* Portfolio Sites Table */}
      <section className="panel">
        <h2>รายชื่อเว็บไซต์ในพอร์ตโฟลิโอ ({data.rows.length})</h2>
        {data.rows.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>เว็บไซต์</th>
                  <th>บทบาท (Role)</th>
                  <th>โหมดการทำงาน (Watch Mode)</th>
                  <th>สถานะ Source</th>
                  <th>รอบเวลา (Stagger)</th>
                  <th>ตรวจล่าสุด</th>
                  <th>การตั้งค่า / การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((site: any) => {
                  const roleThai = getThaiSiteRole(site.site_role || site.siteRole);
                  const modeThai = getThaiWatchMode(site.watch_mode || site.watchMode);
                  const sourceThai = getThaiSourceStatus(site.source_status || site.sourceStatus);

                  return (
                    <tr key={site.id}>
                      <td>
                        <Link href={`/sites/${site.id}`}>
                          <strong>{site.name}</strong>
                        </Link>
                        <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>{site.url}</div>
                      </td>
                      <td>
                        <span className="pill" style={{ background: '#374151', color: '#f3f4f6' }}>
                          {roleThai}
                        </span>
                      </td>
                      <td>
                        <span className="pill" style={{
                          background: (site.watch_mode || site.watchMode) === 'CHANGE_ENABLED' ? '#15803d' : (site.watch_mode || site.watchMode) === 'ANALYSIS_ENABLED' ? '#1d4ed8' : '#4b5563',
                          color: '#fff'
                        }}>
                          {modeThai}
                        </span>
                      </td>
                      <td>
                        <span className="pill" style={{
                          background: (site.source_status || site.sourceStatus) === 'CURRENT' ? '#15803d' : '#6b7280',
                          color: '#fff'
                        }}>
                          {sourceThai}
                        </span>
                      </td>
                      <td>
                        09:{(site.stagger_minute || site.staggerMinute || 0).toString().padStart(2, '0')} น.
                      </td>
                      <td>{formatThaiDateTime(site.lastCrawlAt)}</td>
                      <td>
                        <details style={{ cursor: 'pointer' }}>
                          <summary style={{ fontSize: '0.85rem', color: '#3b82f6' }}>ตั้งค่าโหมด</summary>
                          <form action={updateSitePortfolioAction} style={{ marginTop: '8px', padding: '8px', background: '#1f2937', borderRadius: '6px', fontSize: '0.8rem' }}>
                            <input type="hidden" name="siteId" value={site.id} />
                            <div style={{ marginBottom: '6px' }}>
                              <label style={{ display: 'block', marginBottom: '2px' }}>บทบาท:</label>
                              <select name="siteRole" defaultValue={site.site_role || 'UNCLASSIFIED'}>
                                <option value="PRIMARY_NATIONAL">เว็บหลักระดับประเทศ</option>
                                <option value="NICHE_VERTICAL">เว็บเฉพาะกลุ่มสินค้า</option>
                                <option value="LOCAL_PRIMARY">เว็บหลักพื้นที่</option>
                                <option value="SUPPORTING_SITE">เว็บสนับสนุน</option>
                                <option value="EXPERIMENTAL">เว็บทดลอง</option>
                                <option value="UNCLASSIFIED">ยังไม่ได้กำหนดบทบาท</option>
                              </select>
                            </div>
                            <div style={{ marginBottom: '6px' }}>
                              <label style={{ display: 'block', marginBottom: '2px' }}>โหมดติดตาม:</label>
                              <select name="watchMode" defaultValue={site.watch_mode || 'MONITOR_ONLY'}>
                                <option value="MONITOR_ONLY">ติดตามอย่างเดียว (MONITOR_ONLY)</option>
                                <option value="ANALYSIS_ENABLED">วิเคราะห์ได้ (ANALYSIS_ENABLED)</option>
                                <option value="CHANGE_ENABLED">วิเคราะห์และเสนอการแก้ไข (CHANGE_ENABLED)</option>
                                <option value="DISABLED">ปิดการติดตาม (DISABLED)</option>
                              </select>
                            </div>
                            <div style={{ marginBottom: '8px' }}>
                              <label style={{ display: 'block', marginBottom: '2px' }}>รอบเวลา (นาที):</label>
                              <input name="staggerMinute" type="number" min="0" max="59" defaultValue={site.stagger_minute || 0} style={{ width: '60px' }} />
                            </div>
                            <button type="submit" className="button primary" style={{ padding: '2px 8px', fontSize: '0.75rem' }}>
                              บันทึกการตั้งค่า
                            </button>
                          </form>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">ยังไม่มีเว็บไซต์ในพอร์ตโฟลิโอ</div>
        )}
        <div className="timing">ความเร็วคิวรี {data.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
