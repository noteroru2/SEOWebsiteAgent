import { describe, expect, it } from 'vitest';
import { calendarDate, displayCalendarDate, gscIncrementalDatePlan } from '@seo-agent/shared';

describe('calendar-date boundaries', () => {
  it('formats PostgreSQL Date objects as their local calendar date', () => {
    const databaseDate = new Date(2026, 7, 8);
    expect(calendarDate(databaseDate)).toBe('2026-08-08');
    expect(displayCalendarDate(databaseDate)).toBe('2026-08-08');
  });

  it.each([
    ['00:01 Asia/Bangkok', '2026-08-11T17:01:00.000Z', '2026-08-08'],
    ['23:59 Asia/Bangkok', '2026-08-11T16:59:00.000Z', '2026-08-08'],
    ['23:59 UTC', '2026-08-11T23:59:00.000Z', '2026-08-08'],
    ['00:01 UTC', '2026-08-12T00:01:00.000Z', '2026-08-09'],
  ])('uses UTC calendar boundaries at %s', (_label, instant, expectedEnd) => {
    const plan = gscIncrementalDatePlan(new Date(instant), expectedEnd);
    expect(plan.endDate).toBe(expectedEnd);
    expect(plan.correctionDates).toHaveLength(3);
    expect(plan.correctionDates).toEqual([expect.any(String), expect.any(String), expectedEnd]);
  });

  it('separates missing dates from the latest three-date correction window', () => {
    const plan = gscIncrementalDatePlan(
      new Date('2026-08-11T23:59:00.000Z'),
      new Date(2026, 6, 31),
    );
    expect(plan.missingDates).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ]);
    expect(plan.correctionDates).toEqual(['2026-08-06', '2026-08-07', '2026-08-08']);
    expect(plan.requestedDates).toEqual(plan.missingDates);
  });
});
