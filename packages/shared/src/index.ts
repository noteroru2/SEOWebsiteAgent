import { z } from 'zod';

const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarParts(value: string) {
  const match = calendarDatePattern.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  )
    throw new Error(`Invalid calendar date: ${value}`);
  return { year, month, day };
}

function padded(value: number) {
  return String(value).padStart(2, '0');
}

export function calendarDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid calendar date');
    return `${value.getFullYear()}-${padded(value.getMonth() + 1)}-${padded(value.getDate())}`;
  }
  if (typeof value !== 'string') throw new Error('Calendar date must be a Date or YYYY-MM-DD');
  const parts = calendarParts(value);
  return `${parts.year}-${padded(parts.month)}-${padded(parts.day)}`;
}

export function addCalendarDays(value: string, days: number): string {
  const { year, month, day } = calendarParts(value);
  const instant = new Date(Date.UTC(year, month - 1, day + days));
  return `${instant.getUTCFullYear()}-${padded(instant.getUTCMonth() + 1)}-${padded(instant.getUTCDate())}`;
}

export function utcCalendarDate(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error('Invalid timestamp');
  return `${value.getUTCFullYear()}-${padded(value.getUTCMonth() + 1)}-${padded(value.getUTCDate())}`;
}

export function calendarDateRange(start: string, end: string): string[] {
  calendarParts(start);
  calendarParts(end);
  const result: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addCalendarDays(cursor, 1)) result.push(cursor);
  return result;
}

export function displayCalendarDate(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return calendarDate(value);
}

export function displayUtcTimestamp(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid timestamp');
  const date = utcCalendarDate(timestamp);
  return `${date} ${padded(timestamp.getUTCHours())}:${padded(timestamp.getUTCMinutes())}:${padded(timestamp.getUTCSeconds())} UTC`;
}

export function gscIncrementalDatePlan(now: Date, previousLatest?: unknown) {
  const endDate = addCalendarDays(utcCalendarDate(now), -3);
  const correctionDates = calendarDateRange(addCalendarDays(endDate, -2), endDate);
  if (previousLatest === null || previousLatest === undefined) {
    const requestedDates = calendarDateRange(addCalendarDays(endDate, -27), endDate);
    return {
      startDate: requestedDates[0]!,
      endDate,
      missingDates: requestedDates.slice(0, -3),
      correctionDates,
      requestedDates,
    };
  }
  const latest = calendarDate(previousLatest);
  const missingDates =
    latest < endDate ? calendarDateRange(addCalendarDays(latest, 1), endDate) : [];
  const requestedDates = [...new Set([...missingDates, ...correctionDates])].sort();
  return {
    startDate: requestedDates[0]!,
    endDate,
    missingDates,
    correctionDates,
    requestedDates,
  };
}

export const jobStatuses = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const jobTypes = [
  'SYSTEM_TEST',
  'SITE_CRAWL',
  'GSC_SYNC',
  'GENERATE_OPPORTUNITIES',
  'ANALYZE_OPPORTUNITY',
] as const;
export type JobType = (typeof jobTypes)[number];

export const createSiteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z
    .string()
    .url()
    .refine(
      (value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'Only HTTP(S) URLs are allowed',
    )
    .transform((value) => new URL(value).toString()),
  active: z.boolean().default(true),
  crawlEnabled: z.boolean().default(true),
  maxPages: z.coerce.number().int().min(1).max(5000).default(500),
  crawlDelayMs: z.coerce.number().int().min(0).max(60_000).default(300),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(10_000),
});

export const enqueueJobSchema = z
  .object({
    type: z.enum(jobTypes),
    siteId: z.string().uuid().optional(),
    mode: z.enum(['BOOTSTRAP_28D', 'MANUAL_90D', 'INCREMENTAL']).optional(),
    opportunityId: z.string().uuid().optional(),
    reanalyze: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (['SITE_CRAWL', 'GSC_SYNC', 'GENERATE_OPPORTUNITIES'].includes(value.type) && !value.siteId)
      ctx.addIssue({
        code: 'custom',
        path: ['siteId'],
        message: `${value.type} requires a siteId`,
      });
    if (value.type === 'ANALYZE_OPPORTUNITY' && (!value.siteId || !value.opportunityId))
      ctx.addIssue({
        code: 'custom',
        path: ['opportunityId'],
        message: 'ANALYZE_OPPORTUNITY requires siteId and opportunityId',
      });
  });

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: z.string().default('worker-local-1'),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  STALE_JOB_MINUTES: z.coerce.number().int().min(1).default(15),
  APP_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  APP_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
});
