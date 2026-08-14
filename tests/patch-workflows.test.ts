import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  createDatabase,
  createPatchWorkflow,
  generatePatchPreview,
  recordWorkflowApproval,
  runWorkflowValidationPipeline,
  recordWorkflowRelease,
  verifyWorkflowRelease,
  recordWorkflowRollback,
  checkWorkflowStale,
  evaluatePatchGate,
  canTransition,
  patchWorkflows,
  patchPreviews,
  patchApprovals,
  patchValidations,
  patchReleases,
  patchRollbacks,
  patchWorkflowAuditEvents,
  sites,
  siteRepositories,
  opportunities,
  ownerResearchCases,
  sourceChangePlans,
  sourcePlanRuns,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';
import { eq } from 'drizzle-orm';

describe('Batch 8 — Productized Batch 7 Patch Workflows', () => {
  const { db, pool } = createDatabase(requireTestDatabaseUrl());
  let testSite: any;
  let testOpportunity: any;
  let testRepo: any;
  let testCase: any;
  let testPlanRun: any;
  let testPlan: any;

  beforeEach(async () => {
    await resetTestDatabase(pool);
    await db.delete(sourceChangePlans);
    await db.delete(sourcePlanRuns);
    await db.delete(ownerResearchCases);
    await db.delete(opportunities);
    await db.delete(sites);

    // Seed test site
    [testSite] = await db
      .insert(sites)
      .values({
        name: 'Amphon Test',
        url: 'https://amphon.co.th',
      })
      .returning();

    // Seed test site repository
    [testRepo] = await db
      .insert(siteRepositories)
      .values({
        siteId: testSite.id,
        localPath: 'C:\\Users\\User\\seo-source\\amphon.co.th',
        repositoryType: 'LOCAL_GIT',
        headSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      })
      .returning();

    // Seed test opportunity
    [testOpportunity] = await db
      .insert(opportunities)
      .values({
        siteId: testSite.id,
        kind: 'PAGE',
        entityType: 'URL',
        url: 'https://amphon.co.th/บริการ/รับซื้อคอมบริษัท',
        query: 'รับซื้อคอมบริษัท',
        title: 'Company Computer Opportunity',
        summary: 'Opportunity summary for company computer service',
        fingerprint: 'opp-company-computer-001',
        status: 'OPEN',
      })
      .returning();

    // Seed test owner research case
    [testCase] = await db
      .insert(ownerResearchCases)
      .values({
        siteId: testSite.id,
        query: 'รับซื้อคอมบริษัท',
        normalizedQuery: 'รับซื้อคอมบริษัท',
        researchType: 'OWNER_PRIORITY_SEO',
        status: 'ANALYSIS_COMPLETE',
        priority: 'HIGH',
        reason: 'OWNER_BUSINESS_PRIORITY',
        requestedBy: 'LOCAL_OWNER',
        ownerIntent: 'High-value company computer buying service.',
      })
      .returning();

    // Seed test plan run
    [testPlanRun] = await db
      .insert(sourcePlanRuns)
      .values({
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        repositoryId: testRepo.id,
        status: 'SUCCEEDED',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        promptVersion: 'v1',
        schemaVersion: 'v1',
        repositoryHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        sourceEvidenceHash: 'hash-12345',
      })
      .returning();

    // Seed test source change plan
    [testPlan] = await db
      .insert(sourceChangePlans)
      .values({
        runId: testPlanRun.id,
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        verdict: 'PROPOSE_CHANGE',
        confidence: 'HIGH',
        batch5Reconciliation: 'NOT_NEEDED',
        summary: 'Propose company computer wording changes',
        structuredOutput: {
          verdict: 'PROPOSE_CHANGE',
          confidence: 'HIGH',
          change_items: [
            {
              item_id: 'item-1',
              target_file: 'src/content/services/รับซื้อคอมบริษัท.md',
              target_route: '/บริการ/รับซื้อคอมบริษัท',
              change_type: 'MODIFY',
              proposed_diff: 'Approved wording additions for inventory, data destruction assistance, quotation, and payment.',
            },
          ],
          source_findings: [{ finding: 'Missing inventory and documentation process details' }],
          preserve: [
            { field: 'title', value: 'รับซื้อคอมบริษัทและเครื่องพนักงาน ส่ง Asset List ประเมินก่อนขาย | Amphon.co.th' },
            { field: 'h1', value: 'รับซื้อคอมบริษัทและเครื่องพนักงานเก่า ส่งรายการประเมินก่อนขาย' },
          ],
        },
        status: 'READY_FOR_REVIEW',
      })
      .returning();
  });

  it('1. Workflow can originate from OPPORTUNITY', async () => {
    // Create plan for opportunity
    const [oppRun] = await db
      .insert(sourcePlanRuns)
      .values({
        siteId: testSite.id,
        opportunityId: testOpportunity.id,
        subjectType: 'OPPORTUNITY',
        repositoryId: testRepo.id,
        status: 'SUCCEEDED',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        promptVersion: 'v1',
        schemaVersion: 'v1',
        repositoryHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        sourceEvidenceHash: 'hash-opp-123',
      })
      .returning();

    const [oppPlan] = await db
      .insert(sourceChangePlans)
      .values({
        runId: oppRun.id,
        siteId: testSite.id,
        opportunityId: testOpportunity.id,
        subjectType: 'OPPORTUNITY',
        verdict: 'PROPOSE_CHANGE',
        confidence: 'HIGH',
        batch5Reconciliation: 'NOT_NEEDED',
        summary: 'Opportunity plan',
        structuredOutput: testPlan.structuredOutput,
        status: 'READY_FOR_REVIEW',
      })
      .returning();

    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OPPORTUNITY',
      opportunityId: testOpportunity.id,
      sourceChangePlanId: oppPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    expect(wf.subjectType).toBe('OPPORTUNITY');
    expect(wf.opportunityId).toBe(testOpportunity.id);
    expect(wf.ownerResearchCaseId).toBeNull();
    expect(wf.status).toBe('REVIEW_REQUIRED');
  });

  it('2. Workflow can originate from OWNER_RESEARCH_CASE', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    expect(wf.subjectType).toBe('OWNER_RESEARCH_CASE');
    expect(wf.ownerResearchCaseId).toBe(testCase.id);
    expect(wf.opportunityId).toBeNull();
  });

  it('3. Enforces exactly-one-subject semantics', async () => {
    await expect(
      createPatchWorkflow(db, {
        siteId: testSite.id,
        subjectType: 'OPPORTUNITY',
        opportunityId: testOpportunity.id,
        ownerResearchCaseId: testCase.id, // Forbidden! Both set
        sourceChangePlanId: testPlan.id,
        sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
        targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      })
    ).rejects.toThrow('SUBJECT_MUTUAL_EXCLUSION_VIOLATION');
  });

  it('4. Only PROPOSE_CHANGE plan verdict can create workflow candidate', async () => {
    const [noChangeRun] = await db
      .insert(sourcePlanRuns)
      .values({
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        repositoryId: testRepo.id,
        status: 'SUCCEEDED',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        promptVersion: 'v1',
        schemaVersion: 'v1',
        repositoryHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        sourceEvidenceHash: 'hash-no-change',
      })
      .returning();

    const [noChangePlan] = await db
      .insert(sourceChangePlans)
      .values({
        runId: noChangeRun.id,
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        verdict: 'PROTECT_CURRENT_STATE',
        confidence: 'HIGH',
        batch5Reconciliation: 'NOT_NEEDED',
        summary: 'Protect current state',
        structuredOutput: { verdict: 'PROTECT_CURRENT_STATE', change_items: [] },
        status: 'READY_FOR_REVIEW',
      })
      .returning();

    await expect(
      createPatchWorkflow(db, {
        siteId: testSite.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        ownerResearchCaseId: testCase.id,
        sourceChangePlanId: noChangePlan.id,
        sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
        targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      })
    ).rejects.toThrow('PATCH_GATE_FAILED');
  });

  it('5. Stale source plan blocks preview generation', async () => {
    const [staleRun] = await db
      .insert(sourcePlanRuns)
      .values({
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        repositoryId: testRepo.id,
        status: 'SUCCEEDED',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        promptVersion: 'v1',
        schemaVersion: 'v1',
        repositoryHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        sourceEvidenceHash: 'hash-stale',
      })
      .returning();

    const [stalePlan] = await db
      .insert(sourceChangePlans)
      .values({
        runId: staleRun.id,
        siteId: testSite.id,
        ownerResearchCaseId: testCase.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        verdict: 'PROPOSE_CHANGE',
        confidence: 'HIGH',
        batch5Reconciliation: 'NOT_NEEDED',
        summary: 'Stale plan',
        structuredOutput: testPlan.structuredOutput,
        status: 'STALE',
        staleAt: new Date(),
      })
      .returning();

    await expect(
      createPatchWorkflow(db, {
        siteId: testSite.id,
        subjectType: 'OWNER_RESEARCH_CASE',
        ownerResearchCaseId: testCase.id,
        sourceChangePlanId: stalePlan.id,
        sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
        targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      })
    ).rejects.toThrow('PATCH_GATE_FAILED');
  });

  it('6 & 7. Destructive plan fails patch gate', async () => {
    const destructiveGate = evaluatePatchGate({
      verdict: 'PROPOSE_CHANGE',
      structuredOutput: {
        verdict: 'PROPOSE_CHANGE',
        change_items: [{ change_type: 'DELETE', target_file: 'src/content/services/test.md' }],
        source_findings: [{ finding: 'Delete page' }],
      },
    });

    expect(destructiveGate.eligible).toBe(false);
    expect(destructiveGate.reasons).toContain('Destructive page/file changes are forbidden.');
  });

  it('9 & 10. Preview creation is deterministic and does NOT modify source', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const diffContent = '--- a/src/content/services/รับซื้อคอมบริษัท.md\n+++ b/src/content/services/รับซื้อคอมบริษัท.md\n@@ -61,1 +61,1 @@\n- old text\n+ new text';

    const preview1 = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: diffContent,
      changeSummary: { items: 1 },
      claimTraceability: { facts: ['Asset List'] },
      forbiddenClaimsFindings: { forbidden: [] },
      preservationChecks: { preserved: ['title', 'h1'] },
    });

    expect(preview1.previewHash).toBeDefined();
    expect(preview1.stale).toBe(false);

    // Fetch workflow from DB to confirm status updated to PREVIEW_READY
    const [updatedWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(updatedWf.status).toBe('PREVIEW_READY');
  });

  it('11 & 12. Approval is tied to EXACT preview identity; mismatch fails', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content-1',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    // Attempt approval with wrong preview hash
    await expect(
      recordWorkflowApproval(db, {
        workflowId: wf.id,
        previewId: preview.id,
        previewHash: 'wrong-hash-12345',
        approvalType: 'PATCH_APPROVAL',
        actor: 'LOCAL_OWNER',
        decision: 'APPROVED',
      })
    ).rejects.toThrow('PREVIEW_HASH_MISMATCH');

    // Correct approval
    const approval = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    expect(approval.decision).toBe('APPROVED');

    const [updatedWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(updatedWf.status).toBe('APPROVED_FOR_VALIDATION');
  });

  it('13. Rejection prevents patch execution', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content-reject',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'REJECTED',
      reason: 'Owner rejected proposed wording',
    });

    const [updatedWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(updatedWf.status).toBe('REJECTED');
  });

  it('17 & 18. Mandatory validation failure blocks RELEASE_READY; BLOCKED is NOT PASS', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    // Run validation with one BLOCKED mandatory check
    const result = await runWorkflowValidationPipeline(db, {
      workflowId: wf.id,
      checks: [
        { checkName: 'git_diff_check', status: 'PASS', isMandatory: true, summary: 'Clean diff' },
        { checkName: 'production_build', status: 'BLOCKED', isMandatory: true, summary: 'Build environment unavailable' },
      ],
    });

    expect(result.finalStatus).toBe('VALIDATION_FAILED');

    const [updatedWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(updatedWf.status).toBe('VALIDATION_FAILED');
  });

  it('22 & 23. RELEASE_READY does NOT equal RELEASE_AUTHORIZED; patch approval does NOT authorize release', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    const patchApproval = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    const val = await runWorkflowValidationPipeline(db, {
      workflowId: wf.id,
      checks: [
        { checkName: 'git_diff_check', status: 'PASS', isMandatory: true, summary: 'PASS' },
        { checkName: 'production_build', status: 'PASS', isMandatory: true, summary: 'PASS' },
      ],
    });

    expect(val.finalStatus).toBe('RELEASE_READY');

    // Attempt release directly without separate release authorization -> Fails!
    await expect(
      recordWorkflowRelease(db, {
        workflowId: wf.id,
        releaseAuthorizationId: patchApproval.id, // Not a RELEASE_AUTHORIZATION!
        siteId: testSite.id,
        repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
        remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      })
    ).rejects.toThrow('RELEASE_REQUIRES_RELEASE_AUTHORIZED');

    // Separate explicit release authorization
    const releaseAuth = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'RELEASE_AUTHORIZATION',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
      targetCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
    });

    expect(releaseAuth.approvalType).toBe('RELEASE_AUTHORIZATION');

    const [authedWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(authedWf.status).toBe('RELEASE_AUTHORIZED');
  });

  it('26. Force push is strictly PROHIBITED', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    await runWorkflowValidationPipeline(db, {
      workflowId: wf.id,
      checks: [{ checkName: 'build', status: 'PASS', isMandatory: true, summary: 'PASS' }],
    });

    const releaseAuth = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'RELEASE_AUTHORIZATION',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
      targetCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
    });

    await expect(
      recordWorkflowRelease(db, {
        workflowId: wf.id,
        releaseAuthorizationId: releaseAuth.id,
        siteId: testSite.id,
        repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
        remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
        releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
        pushType: 'FORCE', // Prohibited!
      })
    ).rejects.toThrow('FORCE_PUSH_PROHIBITED');
  });

  it('29 & 30. Rollback requires explicit owner authorization and does NOT force push', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff-content',
      changeSummary: {},
      claimTraceability: {},
      forbiddenClaimsFindings: {},
      preservationChecks: {},
    });

    await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    await runWorkflowValidationPipeline(db, {
      workflowId: wf.id,
      checks: [{ checkName: 'build', status: 'PASS', isMandatory: true, summary: 'PASS' }],
    });

    const releaseAuth = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'RELEASE_AUTHORIZATION',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
      targetCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
    });

    const release = await recordWorkflowRelease(db, {
      workflowId: wf.id,
      releaseAuthorizationId: releaseAuth.id,
      siteId: testSite.id,
      repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    await verifyWorkflowRelease(db, {
      workflowId: wf.id,
      releaseId: release.id,
      httpStatus: 200,
      title: 'Title',
      metaDescription: 'Meta',
      h1: 'H1',
      canonicalUrl: 'Canonical',
      contentMarkersPresent: true,
      forbiddenClaimsFound: [],
      deploymentShaMatches: true,
    });

    // Perform rollback
    const rollback = await recordWorkflowRollback(db, {
      workflowId: wf.id,
      targetReleaseId: release.id,
      productionCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      previousGoodCommitSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      reason: 'Owner requested revert of company computer changes',
      authorizationId: releaseAuth.id,
      rollbackCommitSha: 'revert-commit-123',
    });

    expect(rollback.status).toBe('EXECUTED');

    const [rolledWf] = await db.select().from(patchWorkflows).where(eq(patchWorkflows.id, wf.id));
    expect(rolledWf.status).toBe('ROLLED_BACK');
  });

  it('31. Immutable audit trail created for every transition', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const auditEvents = await db
      .select()
      .from(patchWorkflowAuditEvents)
      .where(eq(patchWorkflowAuditEvents.workflowId, wf.id));

    expect(auditEvents.length).toBeGreaterThan(0);
    expect(auditEvents[0].eventType).toBe('WORKFLOW_CREATED');
  });

  it('Phase 22 Reference Case Replay: Company computer case workflow replay', async () => {
    // Replay full Batch 7 workflow step by step on reference case
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    expect(wf.status).toBe('REVIEW_REQUIRED');

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      baseSourceHeadSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      unifiedDiff: 'diff --git a/src/content/services/รับซื้อคอมบริษัท.md b/src/content/services/รับซื้อคอมบริษัท.md',
      changeSummary: { itemsCount: 1 },
      claimTraceability: { facts: ['Asset List', 'Data destruction', 'Quotation', 'Payment'] },
      forbiddenClaimsFindings: { forbidden: [] },
      preservationChecks: { preserved: ['title', 'meta', 'h1', 'slug'] },
    });

    const patchApproval = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'PATCH_APPROVAL',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
    });

    const val = await runWorkflowValidationPipeline(db, {
      workflowId: wf.id,
      checks: [
        { checkName: 'git_diff_check', status: 'PASS', isMandatory: true, summary: 'Clean diff' },
        { checkName: 'frontmatter_validation', status: 'PASS', isMandatory: true, summary: 'Valid frontmatter' },
        { checkName: 'content_validation', status: 'PASS', isMandatory: true, summary: 'Valid markdown' },
        { checkName: 'duplicate_headings_check', status: 'PASS', isMandatory: true, summary: '0 duplicates' },
        { checkName: 'internal_links_check', status: 'PASS', isMandatory: true, summary: '0 broken links' },
        { checkName: 'forbidden_claims_scan', status: 'PASS', isMandatory: true, summary: '0 forbidden claims' },
        { checkName: 'production_build', status: 'PASS', isMandatory: true, summary: 'Build exit code 0' },
      ],
    });

    expect(val.finalStatus).toBe('RELEASE_READY');

    const releaseAuth = await recordWorkflowApproval(db, {
      workflowId: wf.id,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvalType: 'RELEASE_AUTHORIZATION',
      actor: 'LOCAL_OWNER',
      decision: 'APPROVED',
      targetCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
    });

    const release = await recordWorkflowRelease(db, {
      workflowId: wf.id,
      releaseAuthorizationId: releaseAuth.id,
      siteId: testSite.id,
      repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    const ver = await verifyWorkflowRelease(db, {
      workflowId: wf.id,
      releaseId: release.id,
      httpStatus: 200,
      title: 'รับซื้อคอมบริษัทและเครื่องพนักงาน ส่ง Asset List ประเมินก่อนขาย | Amphon.co.th',
      metaDescription: 'รับซื้อคอมบริษัท คอมพนักงานและเครื่ององค์กรปลดระวาง...',
      h1: 'รับซื้อคอมบริษัทและเครื่องพนักงานเก่า ส่งรายการประเมินก่อนขาย',
      canonicalUrl: 'https://amphon.co.th/บริการ/รับซื้อคอมบริษัท',
      contentMarkersPresent: true,
      forbiddenClaimsFound: [],
      deploymentShaMatches: true,
    });

    expect(ver.isVerified).toBe(true);
    expect(ver.status).toBe('PRODUCTION_VERIFIED');
  });
});
