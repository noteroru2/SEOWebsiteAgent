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
  evidenceReevaluationStateForOpportunity,
  resolveInternalEvidenceForSix,
  localDateTimeInTimeZoneToUtc,
  confirmReusableOwnerFact,
  enqueueSerpCapture,
  confirmSerpCapture,
  discardSerpCapture,
  autoResolveOwnerBusinessConfirmation,
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
  await autoResolveOwnerBusinessConfirmation(opportunityId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export type EvidenceReevaluationActionState = {
  status: 'IDLE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  message: string;
  jobId?: string;
};

function boundedReevaluationError(error: unknown) {
  const code = String((error as { code?: string }).code ?? '');
  if (code === 'AI_BUDGET_EXCEEDED') return 'AI budget exceeded.';
  if (code === 'EVIDENCE_INCOMPLETE') return 'Required evidence is incomplete.';
  if (code === 'AI_PROVIDER_ERROR') return 'The provider request failed.';
  if (code === 'AI_AUTH_ERROR') return 'The AI provider is not configured correctly.';
  if (code === 'AI_RATE_LIMITED') return 'The AI provider is temporarily rate limited.';
  if (error instanceof Error && error.message.includes('required evidence'))
    return 'Required evidence is incomplete.';
  return 'Re-evaluation could not be queued. Review evidence and worker status.';
}

export async function enqueueEvidenceReevaluationAction(
  opportunityId: string,
  siteId: string,
  _previousState: EvidenceReevaluationActionState,
  _formData: FormData,
): Promise<EvidenceReevaluationActionState> {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(siteId))
      throw new Error('Invalid opportunity');
    const existing = await evidenceReevaluationStateForOpportunity(opportunityId);
    if (existing.activeJob) {
      const status = String(existing.activeJob.status) as 'QUEUED' | 'RUNNING';
      return {
        status,
        jobId: String(existing.activeJob.id),
        message: status === 'RUNNING' ? 'Analysis already running.' : 'Analysis already queued.',
      };
    }
    const evidence = await deterministicEvidencePacket(opportunityId);
    if (evidence.completeness !== 'READY_FOR_REEVALUATION')
      throw Object.assign(
        new Error('All required evidence must be resolved before re-evaluation'),
        {
          code: 'EVIDENCE_INCOMPLETE',
        },
      );
    const panel = await aiPanelForOpportunity(opportunityId);
    if (!panel.configured)
      throw Object.assign(new Error('OpenAI is not configured'), { code: 'AI_AUTH_ERROR' });
    const job = await enqueueJob({
      type: 'GENERATE_SOURCE_CHANGE_PLAN',
      siteId,
      opportunityId,
      evidenceReevaluation: true,
      evidencePacketHash: evidence.evidencePacketHash,
    });
    revalidatePath(`/opportunities/${opportunityId}`);
    revalidatePath('/jobs');
    const status = String(job.status) as 'QUEUED' | 'RUNNING';
    return {
      status,
      jobId: String(job.id),
      message: job.deduplicated
        ? status === 'RUNNING'
          ? 'Analysis already running.'
          : 'Analysis already queued.'
        : status === 'RUNNING'
          ? 'Analyzing.'
          : 'Queued.',
    };
  } catch (error) {
    return { status: 'FAILED', message: boundedReevaluationError(error) };
  }
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
  const observedLocalDateTime = required('observedAt');
  const observedTimezone = required('observedTimezone');
  const observedAt = localDateTimeInTimeZoneToUtc(observedLocalDateTime, observedTimezone);
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
    observedTimezone,
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

export async function confirmReusableOwnerFactAction(
  opportunityId: string,
  requestId: string,
  factKey: string,
) {
  await confirmReusableOwnerFact({ opportunityId, requestId, factKey });
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function captureSerpAction(
  opportunityId: string,
  requestId: string,
  formData: FormData,
) {
  const device = String(formData.get('deviceProvenance') ?? '');
  if (!['EMULATED_DESKTOP', 'EMULATED_MOBILE'].includes(device))
    throw new Error('Supported emulated device required');
  const location = String(formData.get('requestedLocationLabel') ?? '').trim();
  const timezone = String(formData.get('timezone') ?? '').trim();
  if (!location || !timezone) throw new Error('Location label and timezone are required');
  const coordinate = (name: string) => {
    const raw = String(formData.get(name) ?? '').trim();
    return raw ? Number(raw) : null;
  };
  const latitude = coordinate('latitude');
  const longitude = coordinate('longitude');
  if ((latitude === null) !== (longitude === null))
    throw new Error('Both coordinates are required');
  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    throw new Error('Invalid latitude');
  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))
    throw new Error('Invalid longitude');
  await enqueueSerpCapture({
    opportunityId,
    requestId,
    deviceProvenance: device as 'EMULATED_DESKTOP' | 'EMULATED_MOBILE',
    requestedLocationLabel: location,
    timezone,
    latitude,
    longitude,
  });
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function confirmSerpCaptureAction(
  opportunityId: string,
  captureId: string,
  formData: FormData,
) {
  const required = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const rawPosition = String(formData.get('approximateOrganicPosition') ?? '').trim();
  const approximateOrganicPosition = rawPosition ? Number(rawPosition) : null;
  if (
    approximateOrganicPosition !== null &&
    (!Number.isInteger(approximateOrganicPosition) || approximateOrganicPosition < 1)
  )
    throw new Error('Organic position must be a positive integer');
  await confirmSerpCapture({
    opportunityId,
    captureId,
    displayedTitle: required('displayedTitle'),
    displayedSnippet: required('displayedSnippet'),
    rankingUrl: required('rankingUrl'),
    approximateOrganicPosition,
    serpFeatures: String(formData.get('serpFeatures') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function discardSerpCaptureAction(opportunityId: string, captureId: string) {
  await discardSerpCapture(captureId);
  revalidatePath(`/opportunities/${opportunityId}`);
}
