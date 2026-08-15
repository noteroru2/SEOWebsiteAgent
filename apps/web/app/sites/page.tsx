import Link from 'next/link';
import { listSites } from '@seo-agent/database';
import { formatThaiDateTime } from '@seo-agent/shared';
import { createConfiguredSite, enqueueSiteCrawl } from '../actions';

export const dynamic = 'force-dynamic';
export default async function Sites() {
  const data: Awaited<ReturnType<typeof listSites>> = await listSites().catch(() => ({
    rows: [],
    timingMs: 0,
  }));
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">การเชื่อมต่อเว็บไซต์</div>
          <h1>เว็บไซต์ในระบบ</h1>
          <p className="muted">การตรวจสอบและติดตามโครงสร้างเว็บไซต์ในความดูแล</p>
        </div>
      </div>
      <section className="panel compact">
        <h2>เพิ่มเว็บไซต์ใหม่</h2>
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
        <p className="hint">
          รองรับเฉพาะเว็บไซต์สาธารณะ HTTP(S) เท่านั้น ไม่อนุญาตให้ใช้ IP ส่วนตัวหรือ Loopback Target
        </p>
      </section>
      <section className="panel">
        {data.rows.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>เว็บไซต์</th>
                  <th>สถานะ</th>
                  <th>ตรวจล่าสุด</th>
                  <th>จำนวนหน้า</th>
                  <th>ดรรชนีได้</th>
                  <th>ข้อควรปรับ</th>
                  <th>การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <Link href={`/sites/${site.id}`}>
                        <strong>{site.name}</strong>
                      </Link>
                      <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>{site.url}</div>
                    </td>
                    <td>
                      <span className="pill">
                        {site.crawlStatus === 'SUCCEEDED' ? 'สำเร็จ' : site.crawlStatus ?? (site.crawlEnabled ? 'พร้อมทำงาน' : 'ปิดการทำงาน')}
                      </span>
                    </td>
                    <td>{formatThaiDateTime(site.lastCrawlAt)}</td>
                    <td>{site.pagesCrawled} หน้า</td>
                    <td>{site.indexablePages} หน้า</td>
                    <td>{site.issueCount} รายการ</td>
                    <td>
                      <form action={enqueueSiteCrawl.bind(null, site.id)}>
                        <button type="submit" className="button secondary" disabled={!site.active || !site.crawlEnabled}>
                          ตรวจสอบหน้าเว็บ
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">ยังไม่มีเว็บไซต์ที่เชื่อมต่อในระบบ</div>
        )}
        <div className="timing">ความเร็วคิวรี {data.timingMs.toFixed(1)} ms</div>
      </section>
    </>
  );
}
