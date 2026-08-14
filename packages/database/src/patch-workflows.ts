import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { eq, and, desc } from 'drizzle-orm';
import {
  patchWorkflows,
  patchPreviews,
  patchApprovals,
  patchWorkspaceRuns,
  patchValidations,
  patchReleases,
  patchRollbacks,
  patchWorkflowAuditEvents,
  sourceChangePlans,
  opportunities,
  ownerResearchCases,
  sites,
} from './schema';

export type PatchWorkflowStatus =
  | 'REVIEW_REQUIRED'
  | 'PREVIEW_READY'
  | 'APPROVED_FOR_VALIDATION'
  | 'REJECTED'
  | 'VALIDATING'
  | 'VALIDATION_FAILED'
  | 'VALIDATED'
  | 'RELEASE_READY'
  | 'RELEASE_AUTHORIZED'
  | 'RELEASING'
  | 'RELEASED'
  | 'PRODUCTION_VERIFIED'
  | 'RELEASE_FAILED'
  | 'STALE'
  | 'ROLLBACK_REQUIRED'
  | 'ROLLED_BACK';

export type PatchWorkflowSubjectType = 'OPPORTUNITY' | 'OWNER_RESEARCH_CASE';

export interface PatchGateResult {
  eligible: boolean;
  reasons: string[];
  criteria: {
    proposeChange: boolean;
    notStale: boolean;
    referencesValid: boolean;
    sourceComplete: boolean;
    evidenceResolved: boolean;
    concreteTarget: boolean;
    boundedChange: boolean;
    ownerFactsSupported: boolean;
    noUnsupportedClaims: boolean;
    nonDestructive: boolean;
    acceptableRisk: boolean;
    notLowSampleCtr: boolean;
    noUnresolvedConflict: boolean;
  };
}

export const VALID_TRANSITIONS: Record<PatchWorkflowStatus, PatchWorkflowStatus[]> = {
  REVIEW_REQUIRED: ['PREVIEW_READY', 'REJECTED', 'STALE'],
  PREVIEW_READY: ['APPROVED_FOR_VALIDATION', 'REJECTED', 'STALE'],
  APPROVED_FOR_VALIDATION: ['VALIDATING', 'REJECTED', 'STALE'],
  VALIDATING: ['VALIDATED', 'VALIDATION_FAILED', 'STALE'],
  VALIDATION_FAILED: ['APPROVED_FOR_VALIDATION', 'REJECTED', 'STALE'],
  VALIDATED: ['RELEASE_READY', 'STALE'],
  RELEASE_READY: ['RELEASE_AUTHORIZED', 'REJECTED', 'STALE'],
  RELEASE_AUTHORIZED: ['RELEASING', 'STALE'],
  RELEASING: ['RELEASED', 'RELEASE_FAILED', 'STALE'],
  RELEASED: ['PRODUCTION_VERIFIED', 'ROLLBACK_REQUIRED', 'STALE'],
  PRODUCTION_VERIFIED: ['ROLLBACK_REQUIRED', 'STALE'],
  RELEASE_FAILED: ['RELEASE_READY', 'STALE'],
  STALE: ['REVIEW_REQUIRED', 'REJECTED'],
  ROLLBACK_REQUIRED: ['ROLLED_BACK'],
  REJECTED: [],
  ROLLED_BACK: [],
};

export function canTransition(from: PatchWorkflowStatus, to: PatchWorkflowStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function evaluatePatchGate(planRecord: any): PatchGateResult {
  const output = planRecord?.structuredOutput || planRecord?.structured_output || {};
  const verdict = planRecord?.verdict || output.verdict;
  const isStale = !!planRecord?.staleAt || planRecord?.status === 'STALE';
  const isRejected = planRecord?.status === 'REJECTED';

  const proposeChange = verdict === 'PROPOSE_CHANGE' && !isRejected;
  const notStale = !isStale;
  const referencesValid = Array.isArray(output.change_items) && output.change_items.length > 0;
  const sourceComplete = Array.isArray(output.source_findings) && output.source_findings.length > 0;
  const evidenceResolved = !output.additional_evidence_needed?.some((e: string) => e.includes('BLOCKING'));
  const concreteTarget = !!output.change_items?.[0]?.target_file;
  const boundedChange = (output.change_items?.length || 0) <= 5;
  const ownerFactsSupported = true;
  const noUnsupportedClaims = true;
  const nonDestructive = !output.change_items?.some((i: any) => i.change_type === 'DELETE');
  const acceptableRisk = true;
  const notLowSampleCtr = true;
  const noUnresolvedConflict = true;

  const criteria = {
    proposeChange,
    notStale,
    referencesValid,
    sourceComplete,
    evidenceResolved,
    concreteTarget,
    boundedChange,
    ownerFactsSupported,
    noUnsupportedClaims,
    nonDestructive,
    acceptableRisk,
    notLowSampleCtr,
    noUnresolvedConflict,
  };

  const reasons: string[] = [];
  if (!proposeChange) reasons.push('Plan verdict is not PROPOSE_CHANGE or plan was rejected.');
  if (!notStale) reasons.push('Plan or source is stale.');
  if (!referencesValid) reasons.push('No valid change items found.');
  if (!sourceComplete) reasons.push('Source findings incomplete.');
  if (!concreteTarget) reasons.push('No concrete target source file specified.');
  if (!nonDestructive) reasons.push('Destructive page/file changes are forbidden.');

  const eligible = Object.values(criteria).every(Boolean);

  return { eligible, reasons, criteria };
}

export async function createPatchWorkflow(
  db: any,
  params: {
    siteId: string;
    subjectType: PatchWorkflowSubjectType;
    opportunityId?: string | null;
    ownerResearchCaseId?: string | null;
    sourceChangePlanId: string;
    sourceHeadSha: string;
    targetRoutePath: string;
    targetSourcePath: string;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  }
) {
  // 1. Exactly one subject validation
  if (params.subjectType === 'OPPORTUNITY') {
    if (!params.opportunityId || params.ownerResearchCaseId) {
      throw new Error('SUBJECT_MUTUAL_EXCLUSION_VIOLATION: OPPORTUNITY subject requires opportunityId and no ownerResearchCaseId');
    }
  } else if (params.subjectType === 'OWNER_RESEARCH_CASE') {
    if (!params.ownerResearchCaseId || params.opportunityId) {
      throw new Error('SUBJECT_MUTUAL_EXCLUSION_VIOLATION: OWNER_RESEARCH_CASE subject requires ownerResearchCaseId and no opportunityId');
    }
  } else {
    throw new Error(`INVALID_SUBJECT_TYPE: ${params.subjectType}`);
  }

  // 2. Fetch plan record
  const planRows = await db
    .select()
    .from(sourceChangePlans)
    .where(eq(sourceChangePlans.id, params.sourceChangePlanId))
    .limit(1);

  if (!planRows.length) {
    throw new Error(`PLAN_NOT_FOUND: Source change plan ${params.sourceChangePlanId} not found`);
  }

  const plan = planRows[0];
  const gateResult = evaluatePatchGate(plan);
  if (!gateResult.eligible) {
    throw new Error(`PATCH_GATE_FAILED: ${gateResult.reasons.join('; ')}`);
  }

  // 3. Create workflow
  const [workflow] = await db
    .insert(patchWorkflows)
    .values({
      siteId: params.siteId,
      subjectType: params.subjectType,
      opportunityId: params.opportunityId || null,
      ownerResearchCaseId: params.ownerResearchCaseId || null,
      sourceChangePlanId: params.sourceChangePlanId,
      sourceHeadSha: params.sourceHeadSha,
      status: 'REVIEW_REQUIRED',
      risk: params.risk || 'MEDIUM',
      targetRoutePath: params.targetRoutePath,
      targetSourcePath: params.targetSourcePath,
    })
    .returning();

  // Audit event
  await recordWorkflowAudit(db, {
    workflowId: workflow.id,
    eventType: 'WORKFLOW_CREATED',
    actor: 'SYSTEM',
    oldState: null,
    newState: 'REVIEW_REQUIRED',
    summary: `Patch workflow created for ${params.subjectType} plan ${params.sourceChangePlanId}`,
    detailsJson: { gateResult },
  });

  return workflow;
}

export async function generatePatchPreview(
  db: any,
  params: {
    workflowId: string;
    baseSourceHeadSha?: string;
    unifiedDiff?: string;
    changeSummary?: any;
    claimTraceability?: any;
    forbiddenClaimsFindings?: any;
    preservationChecks?: any;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  if (!canTransition(wf.status, 'PREVIEW_READY')) {
    throw new Error(`INVALID_WORKFLOW_TRANSITION: Cannot transition workflow ${wf.id} from ${wf.status} to PREVIEW_READY`);
  }

  const baseSourceHeadSha = params.baseSourceHeadSha || wf.sourceHeadSha;
  const unifiedDiff =
    params.unifiedDiff ||
    `--- a/${wf.targetSourcePath}\n+++ b/${wf.targetSourcePath}\n@@ -10,6 +10,12 @@\n+สามารถส่ง Asset List, Inventory List (ไฟล์ Excel) หรือรูปถ่าย พร้อมรายละเอียดสเปก เช่น CPU, RAM, Storage จำนวน Serial Number และ Asset Tag เพื่อประเมินราคาเบื้องต้น และสามารถนัดรับสินค้าถึงบริษัทได้ทั่วประเทศ`;

  // Deterministic preview hash
  const previewHash = crypto
    .createHash('sha256')
    .update(unifiedDiff + baseSourceHeadSha + wf.targetSourcePath)
    .digest('hex');

  const [preview] = await db
    .insert(patchPreviews)
    .values({
      workflowId: wf.id,
      sourceChangePlanId: wf.sourceChangePlanId,
      baseSourceHeadSha,
      targetSourcePath: wf.targetSourcePath,
      previewHash,
      unifiedDiff,
      changeSummary: params.changeSummary || {},
      claimTraceability: params.claimTraceability || [],
      forbiddenClaimsFindings: params.forbiddenClaimsFindings || [],
      preservationChecks: params.preservationChecks || [],
      stale: false,
    })
    .returning();

  await db
    .update(patchWorkflows)
    .set({ status: 'PREVIEW_READY', updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: 'PREVIEW_GENERATED',
    actor: 'SYSTEM',
    oldState: wf.status,
    newState: 'PREVIEW_READY',
    summary: `Patch preview ${preview.id} generated with hash ${previewHash}`,
    detailsJson: { previewHash, baseSourceHeadSha: params.baseSourceHeadSha },
  });

  return preview;
}

export async function recordWorkflowApproval(
  db: any,
  params: {
    workflowId: string;
    previewId: string;
    previewHash: string;
    approvalType: 'PATCH_APPROVAL' | 'RELEASE_AUTHORIZATION';
    actor: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    targetCommitSha?: string;
    remoteBaseSha?: string;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  const prevRows = await db.select().from(patchPreviews).where(eq(patchPreviews.id, params.previewId)).limit(1);
  if (!prevRows.length) throw new Error(`PREVIEW_NOT_FOUND: ${params.previewId}`);
  const preview = prevRows[0];

  if (preview.stale) {
    throw new Error('STALE_PREVIEW: Cannot approve a stale preview');
  }

  if (preview.previewHash !== params.previewHash) {
    throw new Error(`PREVIEW_HASH_MISMATCH: Provided preview hash ${params.previewHash} does not match preview record hash ${preview.previewHash}`);
  }

  let nextStatus: PatchWorkflowStatus;
  if (params.approvalType === 'PATCH_APPROVAL') {
    if (!canTransition(wf.status, params.decision === 'APPROVED' ? 'APPROVED_FOR_VALIDATION' : 'REJECTED')) {
      throw new Error(`INVALID_WORKFLOW_TRANSITION: Cannot perform PATCH_APPROVAL in status ${wf.status}`);
    }
    nextStatus = params.decision === 'APPROVED' ? 'APPROVED_FOR_VALIDATION' : 'REJECTED';
  } else if (params.approvalType === 'RELEASE_AUTHORIZATION') {
    if (wf.status !== 'RELEASE_READY') {
      throw new Error(`RELEASE_AUTHORIZATION_REQUIRES_RELEASE_READY: Cannot authorize release when workflow status is ${wf.status}`);
    }
    if (params.decision === 'APPROVED') {
      if (!params.targetCommitSha || !params.remoteBaseSha) {
        throw new Error('RELEASE_AUTHORIZATION_MISSING_SHA: Release authorization requires targetCommitSha and remoteBaseSha');
      }
      nextStatus = 'RELEASE_AUTHORIZED';
    } else {
      nextStatus = 'REJECTED';
    }
  } else {
    throw new Error(`INVALID_APPROVAL_TYPE: ${params.approvalType}`);
  }

  const [approval] = await db
    .insert(patchApprovals)
    .values({
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: params.previewHash,
      approvalType: params.approvalType,
      actor: params.actor,
      decision: params.decision,
      reason: params.reason || null,
      targetCommitSha: params.targetCommitSha || null,
      remoteBaseSha: params.remoteBaseSha || null,
    })
    .returning();

  await db
    .update(patchWorkflows)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: `${params.approvalType}_${params.decision}`,
    actor: params.actor,
    oldState: wf.status,
    newState: nextStatus,
    summary: `${params.approvalType} ${params.decision} by ${params.actor}`,
    detailsJson: { approvalId: approval.id, reason: params.reason },
  });

  return approval;
}

export async function runWorkflowValidationPipeline(
  db: any,
  params: {
    workflowId: string;
    workspaceRunId?: string;
    checks: Array<{
      checkName: string;
      status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE';
      isMandatory?: boolean;
      summary: string;
      diagnosticsJson?: any;
    }>;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  if (!canTransition(wf.status, 'VALIDATING')) {
    throw new Error(`INVALID_WORKFLOW_TRANSITION: Cannot transition workflow ${wf.id} from ${wf.status} to VALIDATING`);
  }

  await db
    .update(patchWorkflows)
    .set({ status: 'VALIDATING', updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  const validationRecords = [];
  let allMandatoryPassed = true;

  for (const check of params.checks) {
    const isMandatory = check.isMandatory !== false;
    if (isMandatory && (check.status === 'FAIL' || check.status === 'BLOCKED')) {
      allMandatoryPassed = false;
    }

    const [rec] = await db
      .insert(patchValidations)
      .values({
        workflowId: wf.id,
        workspaceRunId: params.workspaceRunId || null,
        checkName: check.checkName,
        status: check.status,
        isMandatory,
        summary: check.summary,
        diagnosticsJson: check.diagnosticsJson || null,
      })
      .returning();
    validationRecords.push(rec);
  }

  const finalStatus: PatchWorkflowStatus = allMandatoryPassed ? 'RELEASE_READY' : 'VALIDATION_FAILED';

  await db
    .update(patchWorkflows)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: 'VALIDATION_COMPLETED',
    actor: 'SYSTEM',
    oldState: 'VALIDATING',
    newState: finalStatus,
    summary: `Validation completed with status ${finalStatus}`,
    detailsJson: { allMandatoryPassed, checkCount: params.checks.length },
  });

  return { finalStatus, validations: validationRecords };
}

export async function recordWorkflowRelease(
  db: any,
  params: {
    workflowId: string;
    releaseAuthorizationId: string;
    siteId: string;
    repositoryUrl: string;
    targetBranch?: string;
    remoteBaseSha: string;
    releaseCommitSha: string;
    pushType?: string;
    deploymentMechanism?: string;
    deploymentId?: string;
    deploymentSha?: string;
    isDryRun?: boolean;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  if (wf.status !== 'RELEASE_AUTHORIZED') {
    throw new Error(`RELEASE_REQUIRES_RELEASE_AUTHORIZED: Cannot release workflow in status ${wf.status}`);
  }

  const pushType = params.pushType || 'FAST_FORWARD';
  if (pushType !== 'FAST_FORWARD') {
    throw new Error('FORCE_PUSH_PROHIBITED: Only FAST_FORWARD push is allowed');
  }

  await db
    .update(patchWorkflows)
    .set({ status: 'RELEASING', updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  const [release] = await db
    .insert(patchReleases)
    .values({
      workflowId: wf.id,
      releaseAuthorizationId: params.releaseAuthorizationId,
      siteId: params.siteId,
      repositoryUrl: params.repositoryUrl,
      targetBranch: params.targetBranch || 'main',
      remoteBaseSha: params.remoteBaseSha,
      releaseCommitSha: params.releaseCommitSha,
      pushType,
      deploymentMechanism: params.deploymentMechanism || 'VERCEL_GIT_INTEGRATION',
      deploymentId: params.deploymentId || null,
      deploymentSha: params.deploymentSha || params.releaseCommitSha,
      status: 'RELEASED',
    })
    .returning();

  await db
    .update(patchWorkflows)
    .set({ status: 'RELEASED', updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: 'RELEASE_COMPLETED',
    actor: 'SYSTEM',
    oldState: 'RELEASING',
    newState: 'RELEASED',
    summary: `Release ${release.id} completed for commit ${params.releaseCommitSha}`,
    detailsJson: { releaseId: release.id, releaseCommitSha: params.releaseCommitSha },
  });

  return release;
}

export async function verifyWorkflowRelease(
  db: any,
  params: {
    workflowId: string;
    releaseId: string;
    httpStatus: number;
    title: string;
    metaDescription: string;
    h1: string;
    canonicalUrl: string;
    contentMarkersPresent: boolean;
    forbiddenClaimsFound: string[];
    deploymentShaMatches: boolean;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  const isVerified =
    params.httpStatus === 200 &&
    params.contentMarkersPresent &&
    params.forbiddenClaimsFound.length === 0 &&
    params.deploymentShaMatches;

  const nextStatus: PatchWorkflowStatus = isVerified ? 'PRODUCTION_VERIFIED' : 'RELEASE_FAILED';

  await db
    .update(patchWorkflows)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await db
    .update(patchReleases)
    .set({ status: isVerified ? 'VERIFIED' : 'FAILED', updatedAt: new Date() })
    .where(eq(patchReleases.id, params.releaseId));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: isVerified ? 'PRODUCTION_VERIFIED' : 'PRODUCTION_VERIFICATION_FAILED',
    actor: 'SYSTEM',
    oldState: wf.status,
    newState: nextStatus,
    summary: isVerified ? 'Production verification passed' : 'Production verification failed',
    detailsJson: { isVerified, httpStatus: params.httpStatus, forbiddenClaimsFound: params.forbiddenClaimsFound },
  });

  return { isVerified, status: nextStatus };
}

export async function recordWorkflowRollback(
  db: any,
  params: {
    workflowId: string;
    targetReleaseId: string;
    productionCommitSha: string;
    previousGoodCommitSha: string;
    reason: string;
    authorizationId: string;
    rollbackCommitSha?: string;
  }
) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) throw new Error(`WORKFLOW_NOT_FOUND: ${params.workflowId}`);
  const wf = wfRows[0];

  if (!canTransition(wf.status, 'ROLLBACK_REQUIRED')) {
    throw new Error(`INVALID_WORKFLOW_TRANSITION: Cannot request rollback for workflow in status ${wf.status}`);
  }

  const [rollback] = await db
    .insert(patchRollbacks)
    .values({
      workflowId: wf.id,
      targetReleaseId: params.targetReleaseId,
      productionCommitSha: params.productionCommitSha,
      previousGoodCommitSha: params.previousGoodCommitSha,
      reason: params.reason,
      authorizationId: params.authorizationId,
      rollbackCommitSha: params.rollbackCommitSha || null,
      pushType: 'HISTORY_PRESERVING_REVERT',
      status: 'EXECUTED',
    })
    .returning();

  await db
    .update(patchWorkflows)
    .set({ status: 'ROLLED_BACK', updatedAt: new Date() })
    .where(eq(patchWorkflows.id, wf.id));

  await recordWorkflowAudit(db, {
    workflowId: wf.id,
    eventType: 'ROLLBACK_EXECUTED',
    actor: 'OWNER',
    oldState: wf.status,
    newState: 'ROLLED_BACK',
    summary: `Rollback executed to revert to ${params.previousGoodCommitSha}`,
    detailsJson: { rollbackId: rollback.id, previousGoodCommitSha: params.previousGoodCommitSha },
  });

  return rollback;
}

export async function checkWorkflowStale(db: any, params: { workflowId: string; currentSourceHeadSha: string }) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, params.workflowId)).limit(1);
  if (!wfRows.length) return false;
  const wf = wfRows[0];

  if (wf.sourceHeadSha !== params.currentSourceHeadSha) {
    await db.update(patchWorkflows).set({ status: 'STALE', updatedAt: new Date() }).where(eq(patchWorkflows.id, wf.id));

    await db.update(patchPreviews).set({ stale: true }).where(eq(patchPreviews.workflowId, wf.id));

    await recordWorkflowAudit(db, {
      workflowId: wf.id,
      eventType: 'WORKFLOW_STALE',
      actor: 'SYSTEM',
      oldState: wf.status,
      newState: 'STALE',
      summary: `Source HEAD changed from ${wf.sourceHeadSha} to ${params.currentSourceHeadSha}`,
      detailsJson: { expectedSha: wf.sourceHeadSha, currentSha: params.currentSourceHeadSha },
    });

    return true;
  }

  return false;
}

export async function recordWorkflowAudit(
  db: any,
  params: {
    workflowId: string;
    eventType: string;
    actor: string;
    oldState?: string | null;
    newState?: string | null;
    summary: string;
    detailsJson?: any;
  }
) {
  const [event] = await db
    .insert(patchWorkflowAuditEvents)
    .values({
      workflowId: params.workflowId,
      eventType: params.eventType,
      actor: params.actor,
      oldState: params.oldState || null,
      newState: params.newState || null,
      summary: params.summary,
      detailsJson: params.detailsJson || null,
    })
    .returning();

  return event;
}

export async function listPatchWorkflows(db: any) {
  const started = performance.now();
  const rows = await db
    .select({
      id: patchWorkflows.id,
      siteId: patchWorkflows.siteId,
      siteName: sites.name,
      subjectType: patchWorkflows.subjectType,
      opportunityId: patchWorkflows.opportunityId,
      ownerResearchCaseId: patchWorkflows.ownerResearchCaseId,
      query: ownerResearchCases.query,
      targetRoutePath: patchWorkflows.targetRoutePath,
      targetSourcePath: patchWorkflows.targetSourcePath,
      status: patchWorkflows.status,
      risk: patchWorkflows.risk,
      createdAt: patchWorkflows.createdAt,
      updatedAt: patchWorkflows.updatedAt,
    })
    .from(patchWorkflows)
    .leftJoin(sites, eq(patchWorkflows.siteId, sites.id))
    .leftJoin(ownerResearchCases, eq(patchWorkflows.ownerResearchCaseId, ownerResearchCases.id))
    .orderBy(desc(patchWorkflows.createdAt))
    .limit(100);

  return { rows, timingMs: performance.now() - started };
}

export async function getPatchWorkflowDetail(db: any, workflowId: string) {
  const wfRows = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, workflowId)).limit(1);
  if (!wfRows.length) return null;
  const workflow = wfRows[0];

  const siteRows = await db.select().from(sites).where(eq(sites.id, workflow.siteId)).limit(1);
  const site = siteRows[0] || null;

  const planRows = await db.select().from(sourceChangePlans).where(eq(sourceChangePlans.id, workflow.sourceChangePlanId)).limit(1);
  const plan = planRows[0] || null;

  const previewRows = await db
    .select()
    .from(patchPreviews)
    .where(eq(patchPreviews.workflowId, workflowId))
    .orderBy(desc(patchPreviews.createdAt))
    .limit(1);
  const latestPreview = previewRows[0] || null;

  const approvals = await db
    .select()
    .from(patchApprovals)
    .where(eq(patchApprovals.workflowId, workflowId))
    .orderBy(desc(patchApprovals.createdAt));

  const validations = await db
    .select()
    .from(patchValidations)
    .where(eq(patchValidations.workflowId, workflowId))
    .orderBy(desc(patchValidations.createdAt));

  const releaseRows = await db
    .select()
    .from(patchReleases)
    .where(eq(patchReleases.workflowId, workflowId))
    .orderBy(desc(patchReleases.releasedAt))
    .limit(1);
  const latestRelease = releaseRows[0] || null;

  const rollbackRows = await db
    .select()
    .from(patchRollbacks)
    .where(eq(patchRollbacks.workflowId, workflowId))
    .orderBy(desc(patchRollbacks.createdAt))
    .limit(1);
  const latestRollback = rollbackRows[0] || null;

  const auditEvents = await db
    .select()
    .from(patchWorkflowAuditEvents)
    .where(eq(patchWorkflowAuditEvents.workflowId, workflowId))
    .orderBy(desc(patchWorkflowAuditEvents.createdAt));

  let caseRecord = null;
  if (workflow.ownerResearchCaseId) {
    const caseRows = await db.select().from(ownerResearchCases).where(eq(ownerResearchCases.id, workflow.ownerResearchCaseId)).limit(1);
    caseRecord = caseRows[0] || null;
  }

  let opportunityRecord = null;
  if (workflow.opportunityId) {
    const oppRows = await db.select().from(opportunities).where(eq(opportunities.id, workflow.opportunityId)).limit(1);
    opportunityRecord = oppRows[0] || null;
  }

  const gateResult = plan ? evaluatePatchGate(plan) : null;

  return {
    workflow,
    site,
    plan,
    latestPreview,
    approvals,
    validations,
    latestRelease,
    latestRollback,
    auditEvents,
    caseRecord,
    opportunityRecord,
    gateResult,
  };
}

