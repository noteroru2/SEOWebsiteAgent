export const THAI_OPPORTUNITY_TYPES: Record<
  string,
  { title: string; description: string }
> = {
  STRIKING_DISTANCE_QUERY: {
    title: 'คีย์เวิร์ดใกล้ขึ้นหน้าแรก',
    description: 'คำค้นนี้มีอันดับอยู่ในช่วงที่อาจพัฒนาให้ดีขึ้นได้',
  },
  LOW_CTR_QUERY: {
    title: 'อันดับดีแต่คนคลิกน้อย',
    description: 'หน้าเว็บมีการแสดงผล แต่สัดส่วนการคลิกต่ำกว่าที่ควรตรวจสอบ',
  },
  UNMAPPED_GSC_PAGE: {
    title: 'พบหน้า Google ที่ยังจับคู่กับ Source ไม่ได้',
    description: 'ระบบพบหน้าจาก Search Console แต่ยังระบุไฟล์ต้นทางไม่ได้ครบถ้วน',
  },
  QUERY_PAGE_OVERLAP_CANDIDATE: {
    title: 'หลายหน้าปรากฏในคำค้นเดียวกัน',
    description:
      'Google แสดงหลายหน้าจากเว็บไซต์สำหรับคำค้นเดียวกัน ระบบต้องตรวจว่าเป็นพฤติกรรมที่เหมาะสมหรือไม่',
  },
  NEW_KEYWORD_CANDIDATE: {
    title: 'พบคำค้นใหม่ที่มีโอกาสเติบโต',
    description: 'มีคำค้นใหม่เริ่มปรากฏในผลการค้นหาของ Google',
  },
  CONTENT_FRESHNESS_CANDIDATE: {
    title: 'เนื้อหาอาจต้องอัปเดตความสดใหม่',
    description: 'หน้าเว็บที่เปิดมานานอาจได้รับการปรับปรุงเนื้อหาเพิ่มเติม',
  },
};

export function getThaiOpportunityType(kind: string | null | undefined) {
  if (!kind) return { title: 'โอกาส SEO ที่ต้องตรวจสอบ', description: 'มีรายการที่ต้องตรวจสอบ' };
  return (
    THAI_OPPORTUNITY_TYPES[kind] ?? {
      title: 'โอกาส SEO ที่ต้องตรวจสอบ',
      description: `ประเภท: ${kind}`,
    }
  );
}

export const THAI_RECOMMENDATIONS: Record<string, string> = {
  PROPOSE_CHANGE: 'แนะนำให้ปรับปรุง',
  PROTECT_CURRENT_STATE: 'ควรรักษาสภาพปัจจุบัน',
  KEEP_CURRENT_STATE: 'ยังไม่ควรเปลี่ยน',
  KEEP_CURRENT_MULTI_PAGE_STATE: 'โครงสร้างหลายหน้าปัจจุบันทำงานเหมาะสม',
  MONITOR: 'ติดตามต่อ',
  EVIDENCE_REQUIRED: 'ต้องการข้อมูลเพิ่มเติม',
  OWNER_INPUT_REQUIRED: 'ต้องการข้อมูลจากเจ้าของ',
  NO_ACTION: 'ยังไม่ต้องดำเนินการ',
};

export function getThaiRecommendation(recommendation: string | null | undefined) {
  if (!recommendation) return 'รอผลประเมิน';
  return THAI_RECOMMENDATIONS[recommendation] ?? recommendation;
}

export const THAI_PRIORITIES: Record<string, string> = {
  HIGH: 'สูง',
  MEDIUM: 'ปานกลาง',
  LOW: 'ต่ำ',
};

export function getThaiPriority(priority: string | null | undefined) {
  if (!priority) return 'ปกติ';
  return THAI_PRIORITIES[priority.toUpperCase()] ?? priority;
}

export const THAI_CONFIDENCE: Record<string, string> = {
  HIGH: 'ความมั่นใจสูง',
  MEDIUM: 'ความมั่นใจปานกลาง',
  LOW: 'ความมั่นใจต่ำ',
};

export function getThaiConfidence(confidence: string | null | undefined) {
  if (!confidence) return 'ปานกลาง';
  return THAI_CONFIDENCE[confidence.toUpperCase()] ?? confidence;
}

export const THAI_JOB_TYPES: Record<string, string> = {
  GENERATE_OPPORTUNITIES: 'ตรวจหาโอกาส SEO',
  SITE_CRAWL: 'ตรวจสอบหน้าเว็บไซต์',
  GSC_SYNC: 'อัปเดตข้อมูล Google Search Console',
  PRODUCTION_OPPORTUNITY_WATCH: 'ตรวจ SEO อัตโนมัติประจำวัน',
  ANALYZE_OPPORTUNITY: 'วิเคราะห์โอกาสด้วย AI',
  REFRESH_SOURCE_REPOSITORY: 'อัปเดตโครงสร้างไฟล์ต้นทาง',
  GENERATE_SOURCE_CHANGE_PLAN: 'สร้างแผนการปรับปรุงโค้ด',
  CAPTURE_SERP: 'ดึงข้อมูลผลการค้นหา SERP',
  FETCH_SERP_API: 'ดึงอันดับจาก SERP API',
  SYSTEM_TEST: 'ทดสอบระบบ',
};

export function getThaiJobType(type: string | null | undefined) {
  if (!type) return 'งานระบบ';
  return THAI_JOB_TYPES[type] ?? type;
}

export const THAI_JOB_STATUSES: Record<string, string> = {
  QUEUED: 'รอดำเนินการ',
  RUNNING: 'กำลังทำงาน',
  SUCCEEDED: 'สำเร็จ',
  FAILED: 'ไม่สำเร็จ',
  CANCELLED: 'ยกเลิก',
};

export function getThaiJobStatus(status: string | null | undefined) {
  if (!status) return '—';
  return THAI_JOB_STATUSES[status] ?? status;
}

export function formatThaiDateTime(dateInput: string | Date | null | undefined) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return String(dateInput);

  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d) + ' น.';
}

export const THAI_SITE_ROLES: Record<string, string> = {
  PRIMARY_NATIONAL: 'เว็บหลักระดับประเทศ',
  NICHE_VERTICAL: 'เว็บเฉพาะกลุ่มสินค้า',
  LOCAL_PRIMARY: 'เว็บหลักพื้นที่',
  SUPPORTING_SITE: 'เว็บสนับสนุน',
  EXPERIMENTAL: 'เว็บทดลอง',
  UNCLASSIFIED: 'ยังไม่ได้กำหนดบทบาท',
};

export function getThaiSiteRole(role: string | null | undefined) {
  if (!role) return 'ยังไม่ได้กำหนดบทบาท';
  return THAI_SITE_ROLES[role.toUpperCase()] ?? role;
}

export const THAI_WATCH_MODES: Record<string, string> = {
  DISABLED: 'ปิดการติดตาม',
  MONITOR_ONLY: 'ติดตามอย่างเดียว',
  ANALYSIS_ENABLED: 'วิเคราะห์ได้',
  CHANGE_ENABLED: 'วิเคราะห์และเสนอการแก้ไขได้',
};

export function getThaiWatchMode(mode: string | null | undefined) {
  if (!mode) return 'ติดตามอย่างเดียว';
  return THAI_WATCH_MODES[mode.toUpperCase()] ?? mode;
}

export const THAI_SOURCE_STATUSES: Record<string, string> = {
  NOT_CONFIGURED: 'ยังไม่ได้ตั้งค่า',
  CONFIGURED_NOT_VERIFIED: 'ตั้งค่าแล้วรอตรวจสอบ',
  CURRENT: 'พร้อมใช้งาน (Current)',
  STALE: 'ล้าสมัย (Stale)',
  IDENTITY_CHANGED: 'โครงสร้างเปลี่ยน',
  UNAVAILABLE: 'ไม่พร้อมใช้งาน',
};

export function getThaiSourceStatus(status: string | null | undefined) {
  if (!status) return 'ยังไม่ได้ตั้งค่า';
  return THAI_SOURCE_STATUSES[status.toUpperCase()] ?? status;
}

export function formatOwnerDomainName(rawInput: string | null | undefined): string {
  if (!rawInput) return '—';
  let host = String(rawInput).trim();
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .replace(/^sc-domain:/i, '');

  try {
    const { domainToUnicode } = require('node:url');
    const unicode = domainToUnicode(host);
    return unicode.normalize('NFC');
  } catch {
    return host;
  }
}


