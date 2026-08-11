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
  });
});
