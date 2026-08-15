import { serpProviderStatus } from '@seo-agent/database';
import { formatThaiDateTime } from '@seo-agent/shared';
import { configureSerpProviderAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SerpProvidersPage() {
  const providers = await serpProviderStatus();
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">ระบบอัตโนมัติข้อมูลผลการค้นหา</div>
          <h1>แหล่งข้อมูลอันดับ (SERP Providers)</h1>
          <p className="muted">เพดานความปลอดภัยสำหรับโหมดฟรี (FREE_ONLY) ของผู้ให้บริการ SERP API</p>
        </div>
      </div>
      {providers.map((provider) => (
        <section className="panel section" key={provider.provider}>
          <h2>ผู้ให้บริการ: {provider.provider}</h2>
          <div className="grid">
            <p>
              <strong>สถานะการเปิดใช้:</strong> {provider.enabled ? 'เปิดใช้งาน (YES)' : 'ปิดใช้งาน (NO)'}
            </p>
            <p>
              <strong>ตั้งค่า API Key:</strong>{' '}
              {provider.credential_configured ? 'ตั้งค่าแล้ว (YES)' : 'ยังไม่ได้ตั้งค่า (NO)'}
            </p>
            <p>
              <strong>โหมดค่าใช้จ่าย:</strong> FREE_ONLY (เฉพาะโหมดฟรี)
            </p>
            <p>
              <strong>สถานะความสมบูรณ์:</strong> {provider.effective_health === 'HEALTHY' ? 'ปกติ (HEALTHY)' : provider.effective_health}
            </p>
            <p>
              <strong>โควต้าฟรีที่กำหนด:</strong> {provider.period_allowance ?? 'ยังไม่ได้เริ่มใช้งาน'}
            </p>
            <p>
              <strong>ใช้ไปแล้ว:</strong> {provider.used} ครั้ง
            </p>
            <p>
              <strong>สำรองไว้:</strong> {provider.reserved} ครั้ง
            </p>
            <p>
              <strong>คงเหลือ:</strong> {provider.remaining} ครั้ง
            </p>
            <p>
              <strong>รอบเวลา:</strong>{' '}
              {provider.period_start
                ? `${formatThaiDateTime(provider.period_start)} → ${provider.period_end ? formatThaiDateTime(provider.period_end) : 'ไม่มีการรีเซ็ตอัตโนมัติ'}`
                : 'รอการตั้งค่าเริ่มต้นจากเจ้าของ'}
            </p>
            <p>
              <strong>ดึงข้อมูลสำเร็จล่าสุด:</strong>{' '}
              {formatThaiDateTime(provider.last_success_at)}
            </p>
            <p>
              <strong>ดึงข้อมูลไม่สำเร็จล่าสุด:</strong>{' '}
              {formatThaiDateTime(provider.last_failure_at)}
            </p>
            <p>
              <strong>ข้อผิดพลาดล่าสุด:</strong> {provider.last_error_category ?? '—'}
            </p>
            <p>
              <strong>ความล้มเหลวต่อเนื่อง:</strong> {provider.consecutive_failures} ครั้ง
            </p>
            <p>
              <strong>เวลาพักระบบ (Cooldown):</strong>{' '}
              {formatThaiDateTime(provider.cooldown_until)}
            </p>
            <p>
              <strong>พร้อมถูกเลือกใช้งาน:</strong> {provider.selection_eligible ? 'พร้อมใช้งาน (YES)' : 'ไม่พร้อมใช้งาน (NO)'}
            </p>
          </div>
          <details style={{ marginTop: '12px' }}>
            <summary style={{ cursor: 'pointer' }}>ตั้งค่าโควต้าโหมดฟรีสำหรับเจ้าของ</summary>
            <form action={configureSerpProviderAction} style={{ marginTop: '12px' }}>
              <input type="hidden" name="provider" value={provider.provider} />
              <label>
                <input type="checkbox" name="enabled" defaultChecked={provider.enabled} /> เปิดใช้งาน
              </label>
              <label>
                จำนวนโควต้าฟรีภายในที่อนุญาต
                <input
                  name="configuredAllowance"
                  type="number"
                  min="0"
                  defaultValue={provider.configured_allowance}
                  required
                />
              </label>
              <label>
                เวลาเริ่มต้นรอบ
                <input name="periodStart" type="datetime-local" required />
              </label>
              <label>
                เวลาสิ้นสุดรอบ (เว้นว่างหากเป็น Credit Pool)
                <input name="periodEnd" type="datetime-local" />
              </label>
              <button type="submit" className="button primary">ยืนยันโควต้าโหมดฟรี</button>
            </form>
          </details>
        </section>
      ))}
    </>
  );
}
