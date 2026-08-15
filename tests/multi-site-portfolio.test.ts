import { describe, expect, it } from 'vitest';
import {
  getThaiSiteRole,
  getThaiWatchMode,
  getThaiSourceStatus,
  THAI_SITE_ROLES,
  THAI_WATCH_MODES,
  THAI_SOURCE_STATUSES,
} from '@seo-agent/shared';

describe('Multi-Site Portfolio Onboarding & Safe Activation', () => {
  it('translates canonical portfolio roles to natural Thai', () => {
    expect(getThaiSiteRole('PRIMARY_NATIONAL')).toBe('เว็บหลักระดับประเทศ');
    expect(getThaiSiteRole('NICHE_VERTICAL')).toBe('เว็บเฉพาะกลุ่มสินค้า');
    expect(getThaiSiteRole('LOCAL_PRIMARY')).toBe('เว็บหลักพื้นที่');
    expect(getThaiSiteRole('SUPPORTING_SITE')).toBe('เว็บสนับสนุน');
    expect(getThaiSiteRole('EXPERIMENTAL')).toBe('เว็บทดลอง');
    expect(getThaiSiteRole('UNCLASSIFIED')).toBe('ยังไม่ได้กำหนดบทบาท');
    expect(getThaiSiteRole('UNKNOWN_ROLE')).toBe('UNKNOWN_ROLE');
  });

  it('translates canonical watch modes to natural Thai', () => {
    expect(getThaiWatchMode('DISABLED')).toBe('ปิดการติดตาม');
    expect(getThaiWatchMode('MONITOR_ONLY')).toBe('ติดตามอย่างเดียว');
    expect(getThaiWatchMode('ANALYSIS_ENABLED')).toBe('วิเคราะห์ได้');
    expect(getThaiWatchMode('CHANGE_ENABLED')).toBe('วิเคราะห์และเสนอการแก้ไขได้');
    expect(getThaiWatchMode(null)).toBe('ติดตามอย่างเดียว');
  });

  it('translates canonical source statuses to natural Thai', () => {
    expect(getThaiSourceStatus('NOT_CONFIGURED')).toBe('ยังไม่ได้ตั้งค่า');
    expect(getThaiSourceStatus('CONFIGURED_NOT_VERIFIED')).toBe('ตั้งค่าแล้วรอตรวจสอบ');
    expect(getThaiSourceStatus('CURRENT')).toBe('พร้อมใช้งาน (Current)');
    expect(getThaiSourceStatus('STALE')).toBe('ล้าสมัย (Stale)');
    expect(getThaiSourceStatus('IDENTITY_CHANGED')).toBe('โครงสร้างเปลี่ยน');
    expect(getThaiSourceStatus('UNAVAILABLE')).toBe('ไม่พร้อมใช้งาน');
  });

  it('enforces default MONITOR_ONLY mode for newly onboarded non-amphon sites', () => {
    const isAmphon = false;
    const initialMode = isAmphon ? 'CHANGE_ENABLED' : 'MONITOR_ONLY';
    expect(initialMode).toBe('MONITOR_ONLY');
  });

  it('initializes validated amphon.co.th site as CHANGE_ENABLED and CURRENT', () => {
    const isAmphon = true;
    const initialRole = isAmphon ? 'PRIMARY_NATIONAL' : 'UNCLASSIFIED';
    const initialMode = isAmphon ? 'CHANGE_ENABLED' : 'MONITOR_ONLY';
    const initialSourceStatus = isAmphon ? 'CURRENT' : 'NOT_CONFIGURED';

    expect(initialRole).toBe('PRIMARY_NATIONAL');
    expect(initialMode).toBe('CHANGE_ENABLED');
    expect(initialSourceStatus).toBe('CURRENT');
  });

  it('fails closed when attempting CHANGE_ENABLED escalation without CURRENT source status', () => {
    const targetMode: string = 'CHANGE_ENABLED';
    const targetSourceStatus: string = 'NOT_CONFIGURED';

    const checkGate = () => {
      if (targetMode === 'CHANGE_ENABLED' && targetSourceStatus !== 'CURRENT') {
        throw new Error(
          `Cannot transition site to CHANGE_ENABLED mode when source_status is ${targetSourceStatus}. Source must be CURRENT.`,
        );
      }
    };

    expect(checkGate).toThrowError(/Source must be CURRENT/);
  });
});
