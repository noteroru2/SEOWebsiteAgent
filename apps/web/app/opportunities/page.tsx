import Link from 'next/link';
import {
  listOpportunities,
  getLatestOpportunityWatchRun,
  getGoldenPathCandidates,
} from '@seo-agent/database';
import {
  formatThaiDateTime,
  getThaiConfidence,
  getThaiOpportunityType,
  getThaiPriority,
  getThaiRecommendation,
} from '@seo-agent/shared';
import { triggerOpportunityWatchAction } from '../actions';
import { OPPORTUNITY_TYPES } from '@seo-agent/opportunity-engine';

export const dynamic = 'force-dynamic';

export default async function Opportunities({
  searchParams,
}: {
  searchParams: Promise<{
    siteId?: string;
    priority?: string;
    type?: string;
    status?: string;
    query?: string;
    url?: string;
  }>;
}) {
  const filters = await searchParams;
  const data = await listOpportunities(filters);
  const activeSiteId = filters.siteId || 'f4ab6ec8-8cdb-4444-a6b6-3dc5c4d20bac';
  const watchRun = await getLatestOpportunityWatchRun(activeSiteId);
  const candidates = await getGoldenPathCandidates(activeSiteId);

  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">ข้อเสนอแนะพัฒนา SEO</div>
          <h1>รายการโอกาส SEO</h1>
          <p className="muted">
            รายการโอกาส SEO ที่ผ่านการตรวจวิเคราะห์เชิงประจักษ์จาก Google Search Console
          </p>
        </div>
      </div>

      <section className="panel section" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div className="eyebrow">การตรวจติดตามอัตโนมัติประจำวัน (Continuous Production Watch)</div>
            <h2>สถานะการตรวจพบโอกาส SEO</h2>
            <p className="hint">
              รอบทำงาน: <strong>ทุกวัน (09:15 Asia/Bangkok)</strong> · คิวงาน: <strong>1</strong> · โหมด: ตรวจพบอย่างเดียว (0 OpenAI / 0 SERP)
            </p>
          </div>
          <form action={triggerOpportunityWatchAction.bind(null, activeSiteId)}>
            <button type="submit" className="button secondary">
              รันการตรวจติดตามทันที
            </button>
          </form>
        </div>

        {candidates.length > 0 ? (
          <div className="notice success-text" style={{ marginTop: '1rem', background: '#f0fdf4', padding: '16px', borderRadius: '8px', borderLeft: '4px solid #16a34a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="pill priority-high" style={{ background: '#16a34a', color: '#fff' }}>พบโอกาสสำคัญที่พร้อมให้เจ้าของตรวจ</span>
              <strong style={{ fontSize: '1.05rem' }}>Golden Path Candidate Ready</strong>
            </div>
            <p className="hint" style={{ marginTop: '0.25rem', color: '#15803d' }}>
              รายการโอกาสนี้ผ่านเกณฑ์หลักฐานและมาตรฐานความปลอดภัย พร้อมให้เริ่มกระบวนการปรับปรุง
            </p>
            <div style={{ marginTop: '1rem' }}>
              {candidates.map((c) => (
                <div key={c.id} className="notice" style={{ marginBottom: '0.5rem', background: '#fff', border: '1px solid #dcfce7', borderRadius: '6px' }}>
                  <p><strong>คำค้น (Query):</strong> {c.query}</p>
                  <p><strong>หน้าเป้าหมาย:</strong> {c.target_url}</p>
                  <p><strong>เหตุผล:</strong> {c.selection_reason}</p>
                  <p className="hint">ระดับความเสี่ยง: {c.risk} · หลักฐานตัวอย่าง: {c.sample_sufficiency} · ไฟล์ต้นทาง: {c.source_file}</p>
                  <div style={{ marginTop: '0.5rem' }}>
                    <Link href={`/opportunities/${c.opportunity_id}`}>
                      <button className="button primary">เริ่มตรวจสอบอย่างละเอียด (Start Governed Review)</button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="notice" style={{ marginTop: '1rem', padding: '12px 16px', borderRadius: '6px' }}>
            <p>
              <strong>ยังไม่มีโอกาสที่ผ่านเกณฑ์ Golden Path ในขณะนี้</strong>
            </p>
            <p className="hint" style={{ margin: '4px 0 0 0' }}>
              ระบบกำลังรอหลักฐานเชิงประจักษ์เพิ่มเติมจาก Google Search Console เพื่อความปลอดภัยในการปรับปรุงเว็บไซต์
            </p>
          </div>
        )}

        <div className="timing" style={{ marginTop: '0.75rem' }}>
          ตรวจล่าสุด: {watchRun?.finished_at ? formatThaiDateTime(watchRun.finished_at) : 'ยังไม่มีการรัน'}
          {' · '}โอกาสทั้งหมด: {data.rows.length} รายการ
          {' · '}พร้อมให้ตรวจ: {candidates.length} รายการ
        </div>
      </section>

      <div className="stats three">
        <Stat label="ความสำคัญสูง" value={data.counts.HIGH ?? 0} />
        <Stat label="ความสำคัญปานกลาง" value={data.counts.MEDIUM ?? 0} />
        <Stat label="ความสำคัญต่ำ" value={data.counts.LOW ?? 0} />
      </div>

      <section className="panel compact section">
        <form className="filters wrap">
          <select name="siteId" defaultValue={filters.siteId ?? ''}>
            <option value="">ทุกเว็บไซต์</option>
            {data.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue={filters.priority ?? ''}>
            <option value="">ทุกระดับความสำคัญ</option>
            <option value="HIGH">สูง (High)</option>
            <option value="MEDIUM">ปานกลาง (Medium)</option>
            <option value="LOW">ต่ำ (Low)</option>
          </select>
          <select name="type" defaultValue={filters.type ?? ''}>
            <option value="">ทุกประเภทโอกาส</option>
            {OPPORTUNITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {getThaiOpportunityType(value).title} ({value})
              </option>
            ))}
          </select>
          <select name="status" defaultValue={filters.status ?? 'OPEN'}>
            <option value="OPEN">เปิดอยู่ (OPEN)</option>
            <option value="MONITOR">กำลังติดตาม (MONITOR)</option>
            <option value="RESOLVED">แก้ไขสำเร็จ (RESOLVED)</option>
            <option value="DISMISSED">ยกเลิก (DISMISSED)</option>
          </select>
          <input name="query" placeholder="กรองด้วยคำค้น" defaultValue={filters.query} />
          <input name="url" placeholder="กรองด้วย URL" defaultValue={filters.url} />
          <button type="submit">กรองข้อมูล</button>
        </form>
      </section>

      <section className="panel section">
        {data.rows.length ? (
          <div className="opportunity-list">
            {data.rows.map((item) => {
              const evidence = item.evidence as Record<string, unknown>;
              const thaiType = getThaiOpportunityType(item.kind);
              const thaiPrio = getThaiPriority(item.priority_label);
              const thaiConf = getThaiConfidence(item.confidence);
              const thaiRec = getThaiRecommendation(item.recommendation);

              return (
                <article className="opportunity-card" key={item.id} style={{ padding: '16px', borderBottom: '1px solid var(--border-color, #333)' }}>
                  <div className="opportunity-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                    <span className={`pill priority-${String(item.priority_label).toLowerCase()}`}>
                      ความสำคัญ: {thaiPrio}
                    </span>
                    <span className="pill">{thaiRec}</span>
                    <strong>คะแนน {item.score}</strong>
                    <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>{thaiConf}</span>
                  </div>
                  <h2 style={{ fontSize: '1.2rem', margin: '4px 0' }}>{thaiType.title}</h2>
                  <p style={{ opacity: 0.8, fontSize: '0.9rem', marginBottom: '8px' }}>{thaiType.description}</p>

                  {item.query ? (
                    <p style={{ margin: '4px 0' }}>
                      <strong>คำค้น (Query):</strong> {item.query}
                    </p>
                  ) : null}
                  {item.url ? (
                    <p className="url-cell" style={{ margin: '4px 0' }}>
                      <strong>หน้าเว็บ (Page):</strong> {item.url}
                    </p>
                  ) : null}
                  <p style={{ margin: '8px 0', fontSize: '0.95rem' }}>{item.summary}</p>
                  <p className="hint">
                    การแสดงผล (Impressions):{' '}
                    {String(
                      evidence.currentImpressions ??
                        (evidence.current as { impressions?: number })?.impressions ??
                        evidence.totalImpressions ??
                        '—',
                    )}
                    {' · '}อันดับเฉลี่ย (Position):{' '}
                    {formatNumber(
                      evidence.currentPosition ??
                        (evidence.current as { position?: number })?.position,
                    )}
                  </p>
                  <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Link href={`/opportunities/${item.id}`} className="button secondary" style={{ fontSize: '0.85rem' }}>
                      เปิดดูหลักฐาน (View Evidence)
                    </Link>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{item.kind}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty">ไม่พบโอกาส SEO ตรงตามเงื่อนไขที่เลือก</div>
        )}
        <div className="timing" style={{ marginTop: '12px' }}>
          ความเร็วคิวรี {data.timingMs.toFixed(1)} ms · แสดงสูงสุด 100 รายการ
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value: unknown) {
  return typeof value === 'number' ? value.toFixed(2) : '—';
}
