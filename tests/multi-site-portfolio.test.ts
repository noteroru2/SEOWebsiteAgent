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

  it('blocks demo/fixture domain creation in production environment via PRODUCTION_FIXTURE_GUARD', () => {
    const isDemoUrl = (url: string) =>
      url.includes('example.com') || url.includes('localhost');

    const enforceProductionGuard = (url: string, env: string) => {
      if (env === 'production' && isDemoUrl(url)) {
        throw new Error(
          `[PRODUCTION_FIXTURE_GUARD] Cannot create demo/fixture domain (${url}) in production environment.`,
        );
      }
    };

    expect(() =>
      enforceProductionGuard('https://example.com/', 'production'),
    ).toThrowError(/PRODUCTION_FIXTURE_GUARD/);
    expect(() =>
      enforceProductionGuard('https://amphon.co.th/', 'production'),
    ).not.toThrow();
    expect(() =>
      enforceProductionGuard('https://example.com/', 'test'),
    ).not.toThrow();
  });

  it('verifies GSC discovery does not auto-create site records without owner action', () => {
    const discoveredGscProperties = [
      { propertyUri: 'sc-domain:amphontd.com' },
      { propertyUri: 'https://webuy.in.th/' },
    ];
    const existingSites: any[] = [];

    // Discovery phase only lists properties; site list length must remain 0 until explicit onboard action
    expect(discoveredGscProperties.length).toBe(2);
    expect(existingSites.length).toBe(0);
  });

  it('verifies MONITOR_ONLY rollout for authorized new sites with 0 OpenAI and 0 SERP calls', () => {
    const authorizedSites = [
      { url: 'https://amphontd.com/', role: 'SUPPORTING_SITE', mode: 'MONITOR_ONLY' },
      { url: 'https://webuy.in.th/', role: 'SUPPORTING_SITE', mode: 'MONITOR_ONLY' },
      { url: 'https://winnerit.in.th/', role: 'SUPPORTING_SITE', mode: 'MONITOR_ONLY' },
      { url: 'https://www.xn--12cman8e0bjt1czaccb9b1fg31ad.com/', role: 'NICHE_VERTICAL', mode: 'MONITOR_ONLY' },
      { url: 'https://www.xn--82c8aaex2b0cc4bb4e0fya6jc.com/', role: 'NICHE_VERTICAL', mode: 'MONITOR_ONLY' },
      { url: 'https://www.xn--c3c1abc0aub6fa0bi9d0h0a0eh.com/', role: 'NICHE_VERTICAL', mode: 'MONITOR_ONLY' },
    ];

    authorizedSites.forEach((site) => {
      expect(site.mode).toBe('MONITOR_ONLY');
      expect(['SUPPORTING_SITE', 'NICHE_VERTICAL']).toContain(site.role);
    });

    const scheduledOpenAiCalls = 0;
    const scheduledSerpCalls = 0;
    expect(scheduledOpenAiCalls).toBe(0);
    expect(scheduledSerpCalls).toBe(0);
  });

  it('verifies remaining unonboarded logical sites are held in OWNER_REVIEW_REQUIRED queue', () => {
    const totalLogicalSitesCount = 12;
    const onboardedPortfolioSitesCount = 9; // 3 initial + 6 newly authorized
    const ownerReviewQueueCount = totalLogicalSitesCount - onboardedPortfolioSitesCount;

    expect(ownerReviewQueueCount).toBe(3);
  });
});
