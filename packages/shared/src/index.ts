import { z } from 'zod';

export const jobStatuses = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const jobTypes = ['SYSTEM_TEST'] as const;
export type JobType = (typeof jobTypes)[number];

export const createSiteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z
    .string()
    .url()
    .refine(
      (value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'Only HTTP(S) URLs are allowed',
    ),
});

export const enqueueJobSchema = z.object({
  type: z.enum(jobTypes),
  siteId: z.string().uuid().optional(),
});

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: z.string().default('worker-local-1'),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  STALE_JOB_MINUTES: z.coerce.number().int().min(1).default(15),
});
