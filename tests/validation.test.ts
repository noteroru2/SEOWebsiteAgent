import { describe, expect, it } from 'vitest';
import { createSiteSchema, enqueueJobSchema } from '@seo-agent/shared';
describe('input validation', () => {
  it('rejects unsafe and invalid URLs', () => {
    expect(createSiteSchema.safeParse({ name: 'x', url: 'file:///etc/passwd' }).success).toBe(
      false,
    );
    expect(
      createSiteSchema.safeParse({ name: 'Valid site', url: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });
  it('accepts only registered job types', () => {
    expect(enqueueJobSchema.safeParse({ type: 'SHELL' }).success).toBe(false);
    expect(enqueueJobSchema.safeParse({ type: 'SITE_CRAWL' }).success).toBe(false);
    expect(
      enqueueJobSchema.safeParse({ type: 'SITE_CRAWL', siteId: crypto.randomUUID() }).success,
    ).toBe(true);
    expect(enqueueJobSchema.safeParse({ type: 'GSC_SYNC' }).success).toBe(false);
    expect(
      enqueueJobSchema.safeParse({ type: 'GSC_SYNC', siteId: crypto.randomUUID() }).success,
    ).toBe(true);
  });
  it('enforces bounded crawl configuration', () => {
    expect(
      createSiteSchema.safeParse({ name: 'Site', url: 'https://example.com', maxPages: 5001 })
        .success,
    ).toBe(false);
    expect(createSiteSchema.parse({ name: 'Site', url: 'https://example.com' }).maxPages).toBe(500);
  });
});
