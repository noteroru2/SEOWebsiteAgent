import { describe, expect, it } from 'vitest';
import {
  formatThaiDateTime,
  getThaiConfidence,
  getThaiHealthStatus,
  getThaiJobStatus,
  getThaiJobType,
  getThaiOpportunityType,
  getThaiPriority,
  getThaiRecommendation,
  THAI_OPPORTUNITY_TYPES,
  THAI_RECOMMENDATIONS,
} from '@seo-agent/shared';

describe('Thai Owner Dashboard & Display Dictionary', () => {
  it('translates known opportunity types into natural Thai', () => {
    expect(getThaiOpportunityType('STRIKING_DISTANCE_QUERY')).toEqual({
      title: 'คีย์เวิร์ดใกล้ขึ้นหน้าแรก',
      description: 'คำค้นนี้มีอันดับอยู่ในช่วงที่อาจพัฒนาให้ดีขึ้นได้',
    });
    expect(getThaiOpportunityType('LOW_CTR_QUERY')).toEqual({
      title: 'อันดับดีแต่คนคลิกน้อย',
      description: 'หน้าเว็บมีการแสดงผล แต่สัดส่วนการคลิกต่ำกว่าที่ควรตรวจสอบ',
    });
    expect(getThaiOpportunityType('UNMAPPED_GSC_PAGE')).toEqual({
      title: 'พบหน้า Google ที่ยังจับคู่กับ Source ไม่ได้',
      description: 'ระบบพบหน้าจาก Search Console แต่ยังระบุไฟล์ต้นทางไม่ได้ครบถ้วน',
    });
    expect(getThaiOpportunityType('QUERY_PAGE_OVERLAP_CANDIDATE')).toEqual({
      title: 'หลายหน้าปรากฏในคำค้นเดียวกัน',
      description:
        'Google แสดงหลายหน้าจากเว็บไซต์สำหรับคำค้นเดียวกัน ระบบต้องตรวจว่าเป็นพฤติกรรมที่เหมาะสมหรือไม่',
    });
  });

  it('safely falls back for unknown or null opportunity types', () => {
    const unknownFallback = getThaiOpportunityType('UNKNOWN_FUTURE_TYPE');
    expect(unknownFallback.title).toBe('โอกาส SEO ที่ต้องตรวจสอบ');
    expect(unknownFallback.description).toContain('UNKNOWN_FUTURE_TYPE');

    const nullFallback = getThaiOpportunityType(null);
    expect(nullFallback.title).toBe('โอกาส SEO ที่ต้องตรวจสอบ');
  });

  it('translates recommendation enums correctly', () => {
    expect(getThaiRecommendation('PROPOSE_CHANGE')).toBe('แนะนำให้ปรับปรุง');
    expect(getThaiRecommendation('PROTECT_CURRENT_STATE')).toBe('ควรรักษาสภาพปัจจุบัน');
    expect(getThaiRecommendation('KEEP_CURRENT_STATE')).toBe('ยังไม่ควรเปลี่ยน');
    expect(getThaiRecommendation('MONITOR')).toBe('ติดตามต่อ');
    expect(getThaiRecommendation('EVIDENCE_REQUIRED')).toBe('ต้องการข้อมูลเพิ่มเติม');
    expect(getThaiRecommendation('OWNER_INPUT_REQUIRED')).toBe('ต้องการข้อมูลจากเจ้าของ');
    expect(getThaiRecommendation('UNKNOWN_REC')).toBe('UNKNOWN_REC');
    expect(getThaiRecommendation(null)).toBe('รอผลประเมิน');
  });

  it('translates priority and confidence labels', () => {
    expect(getThaiPriority('HIGH')).toBe('สูง');
    expect(getThaiPriority('MEDIUM')).toBe('ปานกลาง');
    expect(getThaiPriority('LOW')).toBe('ต่ำ');
    expect(getThaiConfidence('HIGH')).toBe('ความมั่นใจสูง');
    expect(getThaiConfidence('MEDIUM')).toBe('ความมั่นใจปานกลาง');
    expect(getThaiConfidence('LOW')).toBe('ความมั่นใจต่ำ');
  });

  it('translates job types and statuses', () => {
    expect(getThaiJobType('GENERATE_OPPORTUNITIES')).toBe('ตรวจหาโอกาส SEO');
    expect(getThaiJobType('PRODUCTION_OPPORTUNITY_WATCH')).toBe('ตรวจ SEO อัตโนมัติประจำวัน');
    expect(getThaiJobStatus('SUCCEEDED')).toBe('สำเร็จ');
    expect(getThaiJobStatus('FAILED')).toBe('ไม่สำเร็จ');
  });

  it('formats Bangkok datetime correctly', () => {
    const formatted = formatThaiDateTime('2026-08-15T09:15:00.000Z');
    expect(formatted).toContain('15');
    expect(formatted).toContain('น.');
  });

  it('translates system health statuses into Thai', () => {
    expect(getThaiHealthStatus('HEALTHY')).toBe('ปกติ');
    expect(getThaiHealthStatus('DEGRADED')).toBe('ต้องการการตรวจสอบ');
    expect(getThaiHealthStatus('FAILED')).toBe('มีปัญหา');
    expect(getThaiHealthStatus('UNKNOWN')).toBe('ยังตรวจสอบสถานะไม่ได้');
    expect(getThaiHealthStatus('STALE')).toBe('ข้อมูลสถานะล้าสมัย');
    expect(getThaiHealthStatus(null)).toBe('ยังตรวจสอบสถานะไม่ได้');
  });
});
