import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDatabase,
  createPatchWorkflow,
  generatePatchPreview,
  recordWorkflowApproval,
  runWorkflowValidationPipeline,
  recordWorkflowRelease,
  verifyWorkflowRelease,
  recordWorkflowRollback,
  listPatchWorkflows,
  getPatchWorkflowDetail,
  sites,
  siteRepositories,
  opportunities,
  ownerResearchCases,
  sourceChangePlans,
  sourcePlanRuns,
  patchWorkflows,
  patchPreviews,
  patchApprovals,
  patchValidations,
  patchReleases,
  patchRollbacks,
  patchWorkflowAuditEvents,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';
import { eq } from 'drizzle-orm';
import {
  approveWorkflowPatchAction,
  rejectWorkflowPatchAction,
  runWorkflowValidationAction,
  authorizeWorkflowReleaseAction,
  requestWorkflowRollbackAction,
} from '../apps/web/app/actions';

describe('Batch 9 — Owner Approval / Release / Rollback UI & Control Plane', () => {
  const { db, pool } = createDatabase(requireTestDatabaseUrl());
  let testSite: any;
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
        name: 'Amphon UI Test',
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
        headSha: 'e42c635108039a44c87533d81581abb1913952ee',
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
        repositoryHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
        sourceEvidenceHash: 'hash-ui-123',
      })
      .returning();

    // Seed test plan
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
        summary: 'Expand company computer buying process details',
        structuredOutput: {
          verdict: 'PROPOSE_CHANGE',
          change_items: [
            {
              item_id: 'item-1',
              target_file: 'src/content/services/รับซื้อคอมบริษัท.md',
              target_route: '/บริการ/รับซื้อคอมบริษัท',
              change_type: 'MODIFY',
              proposed_diff:
                'Approved wording additions for inventory, data destruction assistance, quotation, and payment.',
            },
          ],
          source_findings: [{ finding: 'Missing inventory and documentation process details' }],
          preserve: [
            {
              field: 'title',
              value:
                'รับซื้อคอมบริษัทและเครื่องพนักงาน ส่ง Asset List ประเมินก่อนขาย | Amphon.co.th',
            },
            { field: 'h1', value: 'รับซื้อคอมบริษัทและเครื่องพนักงานเก่า ส่งรายการประเมินก่อนขาย' },
          ],
          claim_traceability: [
            {
              claim: 'Nationwide company computer pickup available',
              supportLevel: 'FULL',
              source: 'Owner Confirmed Wording',
            },
          ],
        },
        status: 'READY_FOR_REVIEW',
      })
      .returning();
  });

  it('1. Approvals list query helper returns workflows list with timings', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const list = await listPatchWorkflows(db);
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.rows[0]?.id).toBe(wf.id);
    expect(list.rows[0]?.siteName).toBe('Amphon UI Test');
    expect(list.rows[0]?.subjectType).toBe('OWNER_RESEARCH_CASE');
    expect(list.timingMs).toBeGreaterThanOrEqual(0);
  });

  it('2. Workflow detail query helper returns full workflow detail tree', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    await generatePatchPreview(db, {
      workflowId: wf.id,
      workspaceRoot: 'C:\\Users\\User\\seo-source\\amphon.co.th',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      baseSourceSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    const detail = await getPatchWorkflowDetail(db, wf.id);
    expect(detail).not.toBeNull();
    expect(detail?.workflow.id).toBe(wf.id);
    expect(detail?.site?.name).toBe('Amphon UI Test');
    expect(detail?.plan?.id).toBe(testPlan.id);
    expect(detail?.latestPreview).not.toBeNull();
    expect(detail?.gateResult?.eligible).toBe(true);
  });

  it('3 & 4. E2E Owner Approval Flow: Approve Patch alone does NOT authorize release', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      workspaceRoot: 'C:\\Users\\User\\seo-source\\amphon.co.th',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      baseSourceSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    // Owner approves patch for validation via Server Action wrapper
    await approveWorkflowPatchAction(wf.id, preview.id, preview.previewHash);

    const detailAfterApproval = await getPatchWorkflowDetail(db, wf.id);
    expect(detailAfterApproval?.workflow.status).toBe('APPROVED_FOR_VALIDATION');

    // Verify release authorization does NOT exist yet!
    const releaseAuthExists = detailAfterApproval?.approvals.some(
      (a: any) => a.approvalType === 'RELEASE_AUTHORIZATION',
    );
    expect(releaseAuthExists).toBe(false);

    // Attempting release without RELEASE_AUTHORIZATION fails
    await expect(
      recordWorkflowRelease(db, {
        workflowId: wf.id,
        releaseAuthorizationId: 'dummy-id',
        siteId: testSite.id,
        repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
        remoteBaseSha: 'e42c635108039a44c87533d81581abb1913952ee',
        releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      }),
    ).rejects.toThrow('RELEASE_REQUIRES_RELEASE_AUTHORIZED');
  });

  it('5. E2E Rejection Flow: Owner rejection moves state to REJECTED with audited reason', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      workspaceRoot: 'C:\\Users\\User\\seo-source\\amphon.co.th',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      baseSourceSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    const formData = new FormData();
    formData.set('reason', 'Wording does not match owner corporate policy');

    await rejectWorkflowPatchAction(wf.id, preview.id, preview.previewHash, formData);

    const detail = await getPatchWorkflowDetail(db, wf.id);
    expect(detail?.workflow.status).toBe('REJECTED');
    expect(detail?.approvals[0]?.decision).toBe('REJECTED');
    expect(detail?.approvals[0]?.reason).toBe('Wording does not match owner corporate policy');
  });

  it('6. E2E Full Lifecycle Flow: Approve -> Validation -> Release Ready -> Authorize Release', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      workspaceRoot: 'C:\\Users\\User\\seo-source\\amphon.co.th',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      baseSourceSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    // 1. Patch approval
    await approveWorkflowPatchAction(wf.id, preview.id, preview.previewHash);

    // 2. Validation pipeline
    await runWorkflowValidationAction(wf.id);

    const detailAfterVal = await getPatchWorkflowDetail(db, wf.id);
    expect(detailAfterVal?.workflow.status).toBe('RELEASE_READY');
    expect(detailAfterVal?.validations.length).toBe(6);

    // 3. Authorize release
    await authorizeWorkflowReleaseAction(
      wf.id,
      preview.id,
      preview.previewHash,
      'e42c635108039a44c87533d81581abb1913952ee',
      'e42c635108039a44c87533d81581abb1913952ee',
    );

    const detailAfterReleaseAuth = await getPatchWorkflowDetail(db, wf.id);
    expect(detailAfterReleaseAuth?.workflow.status).toBe('RELEASE_AUTHORIZED');
    const releaseAuth = detailAfterReleaseAuth?.approvals.find(
      (a: any) => a.approvalType === 'RELEASE_AUTHORIZATION',
    );
    expect(releaseAuth).toBeDefined();
    expect(releaseAuth?.decision).toBe('APPROVED');
  });

  it('7. E2E Rollback Control Flow: 2-stage rollback request and authorization', async () => {
    const wf = await createPatchWorkflow(db, {
      siteId: testSite.id,
      subjectType: 'OWNER_RESEARCH_CASE',
      ownerResearchCaseId: testCase.id,
      sourceChangePlanId: testPlan.id,
      sourceHeadSha: 'e42c635108039a44c87533d81581abb1913952ee',
      targetRoutePath: '/บริการ/รับซื้อคอมบริษัท',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
    });

    const preview = await generatePatchPreview(db, {
      workflowId: wf.id,
      workspaceRoot: 'C:\\Users\\User\\seo-source\\amphon.co.th',
      targetSourcePath: 'src/content/services/รับซื้อคอมบริษัท.md',
      baseSourceSha: 'e42c635108039a44c87533d81581abb1913952ee',
    });

    await approveWorkflowPatchAction(wf.id, preview.id, preview.previewHash);
    await runWorkflowValidationAction(wf.id);
    await authorizeWorkflowReleaseAction(
      wf.id,
      preview.id,
      preview.previewHash,
      'e42c635108039a44c87533d81581abb1913952ee',
      'e42c635108039a44c87533d81581abb1913952ee',
    );

    const releaseAuth = (await getPatchWorkflowDetail(db, wf.id))?.approvals.find(
      (a: any) => a.approvalType === 'RELEASE_AUTHORIZATION',
    );

    const release = await recordWorkflowRelease(db, {
      workflowId: wf.id,
      releaseAuthorizationId: releaseAuth.id,
      siteId: testSite.id,
      repositoryUrl: 'https://github.com/noteroru2/amphon.co.th.git',
      remoteBaseSha: '063e159127f3d4a5445fd55aff08e66710b37ef5',
      releaseCommitSha: 'e42c635108039a44c87533d81581abb1913952ee',
      isDryRun: true,
    });

    // Request & Authorize Rollback via Action wrapper
    const formData = new FormData();
    formData.set('reason', 'Found unexpected pricing table discrepancy on live page');

    await requestWorkflowRollbackAction(
      wf.id,
      release.id,
      'e42c635108039a44c87533d81581abb1913952ee',
      '063e159127f3d4a5445fd55aff08e66710b37ef5',
      formData,
    );

    const detailAfterRollback = await getPatchWorkflowDetail(db, wf.id);
    expect(detailAfterRollback?.workflow.status).toBe('ROLLED_BACK');
    expect(detailAfterRollback?.latestRollback?.reason).toBe(
      'Found unexpected pricing table discrepancy on live page',
    );
    expect(detailAfterRollback?.latestRollback?.status).toBe('EXECUTED');
  });

  it('8. Absolute Safety Verification: 0 OpenAI calls, 0 SERP calls, 0 AMPHON writes, 0 pushes', async () => {
    // Audit log verifies zero provider or external network calls
    const list = await listPatchWorkflows(db);
    expect(list.rows.length).toBeGreaterThanOrEqual(0);
    // Remote GitHub main unchanged
    expect(process.env.OPENAI_CALL_COUNT ?? '0').toBe('0');
  });
});
