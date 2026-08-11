'use server';
import { createSite, enqueueJob, requestJobCancellation } from '@seo-agent/database';
import { createSiteSchema } from '@seo-agent/shared';
import { assertSafeTarget } from '@seo-agent/crawler';
import { revalidatePath } from 'next/cache';

export async function enqueueSystemTest() {
  await enqueueJob({ type: 'SYSTEM_TEST' });
  revalidatePath('/');
  revalidatePath('/jobs');
}

export async function createConfiguredSite(formData: FormData) {
  const input = createSiteSchema.parse({
    name: formData.get('name'),
    url: formData.get('url'),
    maxPages: formData.get('maxPages') || undefined,
    crawlDelayMs: formData.get('crawlDelayMs') || undefined,
    requestTimeoutMs: formData.get('requestTimeoutMs') || undefined,
    active: true,
    crawlEnabled: true,
  });
  await assertSafeTarget(input.url);
  await createSite(input);
  revalidatePath('/sites');
}

export async function enqueueSiteCrawl(siteId: string) {
  await enqueueJob({ type: 'SITE_CRAWL', siteId });
  revalidatePath('/sites');
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}

export async function cancelCrawl(jobId: string, siteId: string) {
  await requestJobCancellation(jobId);
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}
