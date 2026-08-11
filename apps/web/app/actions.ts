'use server';
import {
  createSite,
  enqueueJob,
  requestJobCancellation,
  mapGscProperty,
  disconnectGsc,
  dismissOpportunity,
  aiPanelForOpportunity,
} from '@seo-agent/database';
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

export async function selectGscProperty(siteId: string, formData: FormData) {
  const propertyId = String(formData.get('propertyId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(propertyId)) throw new Error('Invalid property');
  await mapGscProperty(siteId, propertyId);
  revalidatePath(`/sites/${siteId}`);
  revalidatePath(`/sites/${siteId}/search-console`);
}

export async function enqueueGscSync(
  siteId: string,
  mode: 'BOOTSTRAP_28D' | 'MANUAL_90D' | 'INCREMENTAL' = 'INCREMENTAL',
) {
  await enqueueJob({ type: 'GSC_SYNC', siteId, mode });
  revalidatePath(`/sites/${siteId}`);
  revalidatePath(`/sites/${siteId}/search-console`);
  revalidatePath('/jobs');
}

export async function disconnectGoogle(siteId: string) {
  await disconnectGsc(siteId);
  revalidatePath(`/sites/${siteId}`);
  revalidatePath(`/sites/${siteId}/search-console`);
}

export async function enqueueOpportunityGeneration(siteId: string) {
  await enqueueJob({ type: 'GENERATE_OPPORTUNITIES', siteId });
  revalidatePath('/');
  revalidatePath('/opportunities');
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}

export async function dismissOpportunityAction(opportunityId: string, siteId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(siteId))
    throw new Error('Invalid opportunity');
  await dismissOpportunity(opportunityId);
  revalidatePath('/');
  revalidatePath('/opportunities');
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}`);
}

export async function enqueueAiAnalysis(opportunityId: string, siteId: string, reanalyze = false) {
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(siteId))
    throw new Error('Invalid opportunity');
  const panel = await aiPanelForOpportunity(opportunityId);
  if (!panel.configured) throw new Error('OPENAI_API_KEY is not configured');
  await enqueueJob({ type: 'ANALYZE_OPPORTUNITY', siteId, opportunityId, reanalyze });
  revalidatePath('/');
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}
