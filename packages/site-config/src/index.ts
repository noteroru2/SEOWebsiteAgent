import { z } from 'zod';
export const siteConfigSchema = z.object({
  maxPages: z.number().int().min(1).max(500).default(100),
});
