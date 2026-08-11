import { z } from 'zod';
export const siteConfigSchema = z.object({
  maxPages: z.number().int().min(1).max(5000).default(500),
  crawlDelayMs: z.number().int().min(0).max(60_000).default(300),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(10_000),
});
