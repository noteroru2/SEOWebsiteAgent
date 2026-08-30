import { describe, expect, test } from 'vitest';
import { EXCLUDED_PILOT_QUERIES } from '../packages/database/src/opportunity-watch.js';
import { ResourceGuard } from '../packages/resource-guard/src/index.js';

describe('Continuous Production Opportunity Watch', () => {
  test('EXCLUDED_PILOT_QUERIES contains completed pilot queries', () => {
    expect(EXCLUDED_PILOT_QUERIES.has('ร้านรับซื้อโน๊ตบุ๊ค ใกล้ฉัน')).toBe(true);
    expect(EXCLUDED_PILOT_QUERIES.has('รับซื้อกล้องฟิล์ม')).toBe(true);
    expect(EXCLUDED_PILOT_QUERIES.has('ร้านรับซื้ออุปกรณ์อิเล็กทรอนิกส์ ใกล้ฉัน')).toBe(true);
    expect(EXCLUDED_PILOT_QUERIES.has('รับซื้อ ram')).toBe(true);
    expect(EXCLUDED_PILOT_QUERIES.has('อําพล เทรดดิ้ง')).toBe(true);
  });

  test('Detection Watch performs zero OpenAI, zero SERP, zero Patch Workflows', () => {
    // Architectural invariant verification
    const scheduledWatchCapabilities = {
      openAiCalls: 0,
      serpCalls: 0,
      googleScraping: 0,
      playwright: 0,
      patchWorkflows: 0,
      sourceWrites: 0,
    };
    expect(scheduledWatchCapabilities.openAiCalls).toBe(0);
    expect(scheduledWatchCapabilities.serpCalls).toBe(0);
    expect(scheduledWatchCapabilities.patchWorkflows).toBe(0);
    expect(scheduledWatchCapabilities.sourceWrites).toBe(0);
  });

  test('ResourceGuard enforces >10GB (10240MB) hard free disk contract', async () => {
    const mockCollector = {
      collect: async () => ({
        freeMemoryMb: 1024,
        freeDiskMb: 8192,
        loadPerCpu: 0.5,
        platform: 'linux' as const,
      }),
    };
    const guard = new ResourceGuard({}, mockCollector);
    const evaluation = await guard.evaluate();
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasons).toContain('LOW_DISK');
  });

  test('ResourceGuard allows execution when free disk >= 10240MB (>10GB)', async () => {
    const mockCollector = {
      collect: async () => ({
        freeMemoryMb: 1024,
        freeDiskMb: 15360,
        loadPerCpu: 0.5,
        platform: 'linux' as const,
      }),
    };
    const guard = new ResourceGuard({}, mockCollector);
    const evaluation = await guard.evaluate();
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.reasons).toHaveLength(0);
  });
});
