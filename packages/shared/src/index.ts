import { z } from 'zod';

export const jobStatuses = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const jobTypes = ['SYSTEM_TEST', 'SITE_CRAWL'] as const;
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
  .object({ type: z.enum(jobTypes), siteId: z.string().uuid().optional() })
  .superRefine((value, ctx) => {
    if (value.type === 'SITE_CRAWL' && !value.siteId)
      ctx.addIssue({ code: 'custom', path: ['siteId'], message: 'SITE_CRAWL requires a siteId' });
  });

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: z.string().default('worker-local-1'),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  STALE_JOB_MINUTES: z.coerce.number().int().min(1).default(15),
});
