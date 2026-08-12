'use server';
import {
  createSite,
  enqueueJob,
  requestJobCancellation,
  mapGscProperty,
  disconnectGsc,
  dismissOpportunity,
  aiPanelForOpportunity,
  connectSourceRepository,
  decideSourcePlan,
  storeOwnerEvidence,
  deterministicEvidencePacket,
  resolveInternalEvidenceForSix,
} from '@seo-agent/database';
import { inspectRepository } from '@seo-agent/source-understanding';
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

export async function connectSourceRepositoryAction(siteId: string, formData: FormData) {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error('Invalid site');
  const state = await inspectRepository(String(formData.get('localRoot') ?? '').trim());
  if (!state.clean) throw new Error('Source repository worktree must be clean');
  await connectSourceRepository({
    siteId,
    localRoot: state.root,
    expectedRemote: state.originUrl ?? undefined,
    defaultBranch: state.branch ?? undefined,
  });
  await enqueueJob({ type: 'REFRESH_SOURCE_REPOSITORY', siteId });
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}

export async function enqueueSourceRefresh(siteId: string) {
  await enqueueJob({ type: 'REFRESH_SOURCE_REPOSITORY', siteId });
  revalidatePath(`/sites/${siteId}`);
  revalidatePath('/jobs');
}

export async function enqueueSourcePlan(opportunityId: string, siteId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(siteId))
    throw new Error('Invalid opportunity');
  await enqueueJob({ type: 'GENERATE_SOURCE_CHANGE_PLAN', siteId, opportunityId });
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath('/jobs');
}

export async function refreshInternalEvidenceAction(opportunityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId)) throw new Error('Invalid opportunity');
  const refreshed = await resolveInternalEvidenceForSix();
  if (!refreshed.some((item) => item.opportunityId === opportunityId))
    throw new Error('Opportunity is outside the current evidence-resolution scope');
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function enqueueEvidenceReevaluationAction(opportunityId: string, siteId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(siteId))
    throw new Error('Invalid opportunity');
  const evidence = await deterministicEvidencePacket(opportunityId);
  if (evidence.completeness !== 'READY_FOR_REEVALUATION')
    throw new Error('All required evidence must be resolved before re-evaluation');
  const panel = await aiPanelForOpportunity(opportunityId);
  if (!panel.configured) throw new Error('OPENAI_API_KEY is not configured');
  await enqueueJob({
    type: 'GENERATE_SOURCE_CHANGE_PLAN',
    siteId,
    opportunityId,
    evidenceReevaluation: true,
  });
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath('/jobs');
}

export async function decideSourcePlanAction(planId: string, decision: 'APPROVED' | 'REJECTED') {
  if (!/^[0-9a-f-]{36}$/i.test(planId)) throw new Error('Invalid source plan');
  await decideSourcePlan(planId, decision);
  revalidatePath('/approvals');
}

export async function addSerpObservationAction(
  opportunityId: string,
  requestId: string,
  formData: FormData,
) {
  const required = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const observedAt = new Date(String(formData.get('observedAt') ?? ''));
  if (Number.isNaN(observedAt.getTime())) throw new Error('Valid observation date required');
  const rankingUrl = new URL(required('rankingUrl'));
  if (!['http:', 'https:'].includes(rankingUrl.protocol))
    throw new Error('Ranking URL must use HTTP or HTTPS');
  const approximatePosition = formData.get('approximatePosition')
    ? Number(formData.get('approximatePosition'))
    : null;
  if (
    approximatePosition !== null &&
    (!Number.isFinite(approximatePosition) || approximatePosition < 1)
  )
    throw new Error('Approximate position must be a positive number');
  await storeOwnerEvidence({
    requestId,
    sourceType: 'OWNER_OBSERVED_SERP',
    observedAt,
    evidence: {
      query: required('query'),
      location: required('location'),
      device: required('device'),
      displayedTitle: required('displayedTitle'),
      displayedSnippet: required('displayedSnippet'),
      rankingUrl: rankingUrl.toString(),
      approximatePosition,
      serpFeatures: String(formData.get('serpFeatures') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      notes: String(formData.get('notes') ?? '').trim() || null,
    },
  });
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function addOwnerEvidenceAction(
  opportunityId: string,
  requestId: string,
  formData: FormData,
) {
  const required = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  await storeOwnerEvidence({
    requestId,
    sourceType: 'OWNER_CONFIRMED',
    evidence: {
      statement: required('statement'),
      confirmation: required('confirmation'),
      scope: required('scope'),
      notes: String(formData.get('notes') ?? '').trim() || null,
    },
  });
  revalidatePath(`/opportunities/${opportunityId}`);
}
