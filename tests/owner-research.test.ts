import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  companyComputerOwnerFactValues,
  confirmDirectOwnerFact,
  createDatabase,
  createOwnerResearchCase,
  createSite,
  buildOwnerResearchV3Context,
  diagnoseSerpQuota,
  ensureEvidenceRequest,
  ensureResearchEvidenceRequest,
  getOwnerResearchCase,
  normalizeOwnerResearchQuery,
  reassessOwnerResearchCase,
  recordOwnerResearchAiAuthorization,
  enqueueJob,
  sourcePanelForOwnerResearch,
} from '@seo-agent/database';
import { ResourceGuard } from '@seo-agent/resource-guard';
import type { SourcePlanProvider } from '@seo-agent/source-understanding';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const execFileAsync = promisify(execFile);
const database = createDatabase(requireTestDatabaseUrl());
const query = 'รับซื้อคอมบริษัท';
const officePage = 'https://amphon.example.test/บริการ/รับซื้อคอมสำนักงาน';
const companyPage = 'https://amphon.example.test/บริการ/รับซื้อคอมบริษัท';
let siteId = '';
let parent = '';
let repository = '';
let repositoryHead = '';
const guard = new ResourceGuard(
  {},
  {
    collect: async () => ({
      freeMemoryMb: 2000,
      freeDiskMb: 20_000,
      loadPerCpu: 0,
      platform: 'linux',
    }),
  },
);

class OwnerResearchProvider implements SourcePlanProvider {
  calls = 0;
  lastInput: Parameters<SourcePlanProvider['generate']>[0] | null = null;
  async generate(input: Parameters<SourcePlanProvider['generate']>[0]) {
    this.calls++;
    this.lastInput = input;
    const file = input.context.files[0]!;
    return {
      result: {
        verdict: 'NEEDS_MORE_EVIDENCE' as const,
        confidence: 'MEDIUM' as const,
        batch5_reconciliation: 'NOT_NEEDED' as const,
        summary:
          'à¸„à¸§à¸£à¸¢à¸·à¸™à¸¢à¸±à¸™à¸šà¸—à¸šà¸²à¸—à¸«à¸™à¹‰à¸²à¸ˆà¸²à¸à¸«à¸¥à¸±à¸à¸à¸²à¸™à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸•à¸´à¸¡à¸à¹ˆà¸­à¸™à¹à¸à¹‰à¹„à¸‚',
        source_findings: [],
        change_items: [],
        preserve: [
          {
            path: file.path,
            section: 'à¹€à¸™à¸·à¹‰à¸­à¸«à¸²à¸›à¸±à¸ˆà¸ˆà¸¸à¸šà¸±à¸™',
            reason: 'à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸«à¸¥à¸±à¸à¸à¸²à¸™à¸§à¹ˆà¸²à¹€à¸ªà¸µà¸¢à¸«à¸²à¸¢',
          },
        ],
        additional_evidence_needed: [
          'à¸•à¸£à¸§à¸ˆà¸ªà¸­à¸šà¸šà¸—à¸šà¸²à¸—à¸«à¸™à¹‰à¸²à¸”à¹‰à¸§à¸¢à¸«à¸¥à¸±à¸à¸à¸²à¸™à¸—à¸µà¹ˆà¸ˆà¸³à¸à¸±à¸”',
        ],
        unknowns: [
          'à¸œà¸¥à¸à¸£à¸°à¸—à¸šà¸‚à¸­à¸‡à¸à¸²à¸£à¹à¸¢à¹ˆà¸‡à¸„à¸µà¸¢à¹Œà¹€à¸§à¸´à¸£à¹Œà¸”à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸¢à¸·à¸™à¸¢à¸±à¸™',
        ],
      },
      providerRequestId: 'owner-research-provider-1',
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      latencyMs: 10,
    };
  }
}

const caseInput = () => ({
  siteId,
  query,
  researchType: 'OWNER_PRIORITY_SEO' as const,
  reason: 'OWNER_BUSINESS_PRIORITY' as const,
  priority: 'HIGH' as const,
  requestedBy: 'LOCAL_OWNER',
  ownerIntent: 'High-value company/corporate computer-buying service.',
  targetPage: companyPage,
  ownerAuthorized: true as const,
});

async function git(args: string[]) {
  return (
    await execFileAsync('git', ['-c', `safe.directory=${repository}`, ...args], { cwd: repository })
  ).stdout.trim();
}

async function registerCompanyFacts() {
  for (const item of companyComputerOwnerFactValues)
    await confirmDirectOwnerFact(
      {
        siteId,
        factKey: item.factKey,
        value: item.value,
        scopeType: item.scopeType,
        scopeKey: item.scopeKey,
        provenance: 'OWNER_CONFIRMED_DIRECT',
        reviewStatus: 'OWNER_CONFIRMED',
        confirmedBy: 'LOCAL_OWNER',
        sourceContext: 'owner-research-test',
        ownerAuthorized: true,
      },
      database.pool,
    );
}

async function seedResearchContext() {
  const repositoryId = (
    await database.pool.query(
      `INSERT INTO site_repositories(site_id,local_path,repository_type,enabled,head_sha,
        current_branch,worktree_clean) VALUES($1,$2,'LOCAL_GIT',true,$3,'main',true) RETURNING id`,
      [siteId, repository, repositoryHead],
    )
  ).rows[0].id;
  for (const [route, sourcePath] of [
    ['/บริการ/รับซื้อคอมสำนักงาน', 'content/office.md'],
    ['/บริการ/รับซื้อคอมบริษัท', 'content/company.md'],
  ])
    await database.pool.query(
      `INSERT INTO source_route_mappings(site_id,repository_id,route_url,route_path,mapping_status,
        primary_source_path,repository_head_sha,mapping_evidence)
       VALUES($1,$2,$3,$4,'CONTENT_COLLECTION_MAPPING',$5,$6,'{}')`,
      [
        siteId,
        repositoryId,
        `https://amphon.example.test${route}`,
        route,
        sourcePath,
        repositoryHead,
      ],
    );
  const propertyId = (
    await database.pool.query(
      `INSERT INTO gsc_properties(property_uri,property_type,permission_level)
       VALUES('sc-domain:amphon.example.test','DOMAIN','siteOwner') RETURNING id`,
    )
  ).rows[0].id;
  await database.pool.query(
    `INSERT INTO gsc_sync_summaries(site_id,property_id,last_finalized_date)
     VALUES($1,$2,'2026-08-08')`,
    [siteId, propertyId],
  );
  await database.pool.query(
    `INSERT INTO gsc_query_metrics(site_id,property_id,metric_date,query,clicks,impressions,ctr,position)
     VALUES($1,$2,'2026-08-08',$3,0,15,0,5.6)`,
    [siteId, propertyId, query],
  );
  await database.pool.query(
    `INSERT INTO gsc_query_page_metrics(site_id,property_id,metric_date,query,page,clicks,impressions,ctr,position)
     VALUES($1,$2,'2026-08-08',$3,$4,0,14,0,5.285714),
            ($1,$2,'2026-08-08',$3,$5,0,1,0,10)`,
    [siteId, propertyId, query, officePage, companyPage],
  );
  const crawlRunId = (
    await database.pool.query(
      `INSERT INTO crawl_runs(site_id,status,started_at,finished_at) VALUES($1,'SUCCEEDED',now(),now()) RETURNING id`,
      [siteId],
    )
  ).rows[0].id;
  await database.pool.query(
    `INSERT INTO crawl_pages(crawl_run_id,url,title,meta_description,primary_h1,indexable)
     VALUES($1,$2,'รับซื้อคอมสำนักงาน','บริการคอมสำนักงาน','รับซื้อคอมสำนักงาน',true),
           ($1,$3,'รับซื้อคอมบริษัท','บริการคอมบริษัท','รับซื้อคอมบริษัท',true)`,
    [crawlRunId, officePage, companyPage],
  );
}

async function readyResearchCase() {
  await seedResearchContext();
  await registerCompanyFacts();
  const created = await createOwnerResearchCase(caseInput(), database.pool);
  await reassessOwnerResearchCase(created.researchCase.id, database.pool, {
    sourceAllowedRoots: [parent],
  });
  return created.researchCase.id as string;
}

describe('owner-priority research workflow', () => {
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    parent = await mkdtemp(path.join(tmpdir(), 'owner-research-'));
    repository = path.join(parent, 'source');
    await mkdir(path.join(repository, 'content'), { recursive: true });
    await writeFile(
      path.join(repository, 'content', 'office.md'),
      '# รับซื้อคอมสำนักงาน\nสำหรับเครื่องสำนักงานทั่วไป ส่งรูปและสเปกเพื่อประเมินเบื้องต้น\n',
    );
    await writeFile(
      path.join(repository, 'content', 'company.md'),
      '# รับซื้อคอมบริษัท\nDesktop Mini PC Workstation Notebook เปิดไม่ติด และหลายเครื่อง\nส่ง Inventory List, Asset Tag และ Serial เพื่อประเมินเบื้องต้น ก่อนตรวจและยืนยันราคา\n',
    );
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.name', 'Owner Research Test'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'owner-research@example.test'], {
      cwd: repository,
    });
    await execFileAsync('git', ['add', '.'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repository });
    repositoryHead = await git(['rev-parse', 'HEAD']);
  });
  beforeEach(async () => {
    process.env.SOURCE_REPO_ALLOWED_ROOTS = parent;
    await resetTestDatabase(database.pool);
    siteId = (
      await createSite(
        { name: 'AMPHON Research Fixture', url: 'https://amphon.example.test/' },
        database.db,
      )
    ).id;
  });
  afterAll(async () => {
    await database.pool.end();
    await rm(parent, { recursive: true, force: true });
  });

  it('creates an owner-authorized case without an opportunity or executable work', async () => {
    const result = await createOwnerResearchCase(caseInput(), database.pool);
    expect(result).toMatchObject({ created: true, reused: false });
    expect(result.researchCase).toMatchObject({
      opportunity_id: null,
      normalized_query: query,
      status: 'DRAFT',
      reason: 'OWNER_BUSINESS_PRIORITY',
    });
    const counts = (
      await database.pool.query(
        `SELECT (SELECT count(*)::int FROM opportunities) opportunities,
          (SELECT count(*)::int FROM jobs) jobs,
          (SELECT count(*)::int FROM ai_usage) ai_usage,
          (SELECT count(*)::int FROM serp_api_captures) serp_captures`,
      )
    ).rows[0];
    expect(counts).toEqual({ opportunities: 0, jobs: 0, ai_usage: 0, serp_captures: 0 });
  });

  it('requires authorization, an active site, and a normalized query', async () => {
    await expect(
      createOwnerResearchCase({ ...caseInput(), ownerAuthorized: false } as never, database.pool),
    ).rejects.toThrow('Explicit owner authorization');
    await expect(
      createOwnerResearchCase({ ...caseInput(), query: '   ' }, database.pool),
    ).rejects.toThrow('research query');
    await expect(
      createOwnerResearchCase({ ...caseInput(), siteId: crypto.randomUUID() }, database.pool),
    ).rejects.toThrow('Active site required');
    expect(normalizeOwnerResearchQuery('  รับซื้อคอมบริษัท  ')).toBe(query);
  });

  it('deduplicates active identity while preserving owner-request audit events', async () => {
    const first = await createOwnerResearchCase(caseInput(), database.pool);
    const second = await createOwnerResearchCase(caseInput(), database.pool);
    expect(second).toMatchObject({ created: false, reused: true });
    expect(second.researchCase.id).toBe(first.researchCase.id);
    const counts = (
      await database.pool.query(
        `SELECT (SELECT count(*)::int FROM owner_research_cases) cases,
          (SELECT count(*)::int FROM owner_research_requests) requests`,
      )
    ).rows[0];
    expect(counts).toEqual({ cases: 1, requests: 2 });
  });

  it('enforces exactly one evidence subject and preserves legacy opportunity evidence', async () => {
    const research = await createOwnerResearchCase(caseInput(), database.pool);
    const opportunityId = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
         VALUES($1,'LOW_CTR_QUERY','legacy','Legacy','Legacy','legacy-research-xor','OPEN') RETURNING id`,
        [siteId],
      )
    ).rows[0].id;
    const legacy = await ensureEvidenceRequest(
      {
        opportunityId,
        type: 'GSC_COMPARISON_WINDOW',
        requirement: 'Legacy evidence',
        reason: 'Regression',
        source: 'GSC',
      },
      database.pool,
    );
    expect(legacy.opportunity_id).toBe(opportunityId);
    expect(legacy.owner_research_case_id).toBeNull();
    const researchRequest = await ensureResearchEvidenceRequest(
      {
        ownerResearchCaseId: research.researchCase.id,
        type: 'RESEARCH_NEWER_GSC_WINDOW',
        requirement: 'Optional newer GSC',
        reason: 'Optional',
        source: 'STORED_GSC_ONLY',
        required: false,
      },
      database.pool,
    );
    expect(researchRequest.opportunity_id).toBeNull();
    expect(researchRequest.owner_research_case_id).toBe(research.researchCase.id);
    await expect(
      database.pool.query(
        `INSERT INTO evidence_requests(type,requirement,reason,source)
         VALUES('GSC_COMPARISON_WINDOW','Invalid','Invalid','NONE')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query(
        `INSERT INTO evidence_requests(opportunity_id,owner_research_case_id,type,requirement,reason,source)
         VALUES($1,$2,'GSC_COMPARISON_WINDOW','Invalid both','Invalid','NONE')`,
        [opportunityId, research.researchCase.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('loads stored GSC, source mappings, and all canonical owner facts without external execution', async () => {
    await seedResearchContext();
    await registerCompanyFacts();
    const beforeStatus = await git(['status', '--short']);
    const beforeCounts = (
      await database.pool.query(
        `SELECT (SELECT count(*)::int FROM jobs) jobs,(SELECT count(*)::int FROM ai_usage) ai,
          (SELECT coalesce(sum(used),0)::int FROM serp_provider_usage_periods) serp`,
      )
    ).rows[0];
    const created = await createOwnerResearchCase(caseInput(), database.pool);
    const assessment = await reassessOwnerResearchCase(created.researchCase.id, database.pool, {
      sourceAllowedRoots: [parent],
    });
    expect(assessment).toMatchObject({
      status: 'READY_FOR_ANALYSIS',
      readyForAnalysis: true,
      blockers: [],
      ownerFacts: { required: 13, applicable: 13, missing: [], conflicts: [] },
      evidenceReadiness: {
        gsc: 'NOT_NEEDED',
        queryPage: 'NOT_NEEDED',
        source: 'NOT_NEEDED',
        ownerFacts: 'NOT_NEEDED',
        serp: 'OPTIONAL',
        newerGsc: 'OPTIONAL',
      },
      ownerAuthorizationRequiredForAi: true,
      changeCandidate: false,
      patchEligible: false,
      readyForBatch7: false,
    });
    expect(assessment.gsc.metrics).toEqual({ clicks: 0, impressions: 15, ctr: 0, position: 5.6 });
    expect(assessment.gsc.pages.map((item) => item.impressions)).toEqual([14, 1]);
    expect(assessment.source).toMatchObject({
      available: true,
      headSha: repositoryHead,
      clean: true,
    });
    expect(Object.fromEntries(assessment.findings.map((item) => [item.type, item.status]))).toEqual(
      {
        PAGE_INTENT_MISMATCH: 'PRESENT',
        POTENTIAL_CANNIBALIZATION: 'PRESENT_UNPROVEN_HARM',
        TITLE_META_ALIGNMENT_GAP: 'PRESENT',
        BUSINESS_PROCESS_GAP: 'PRESENT',
        INSUFFICIENT_BUSINESS_EVIDENCE: 'RESOLVED',
      },
    );
    const stored = await getOwnerResearchCase(created.researchCase.id, database.pool);
    expect(stored?.ownerFacts).toHaveLength(13);
    expect(stored?.sourceMappings).toHaveLength(2);
    expect(stored?.evidenceRequests).toHaveLength(2);
    const serialized = JSON.stringify(
      stored?.ownerFacts.map((fact) => ({
        factKey: fact.fact_key,
        value: fact.value_json,
        metadata: fact.metadata,
      })),
    ).toLowerCase();
    for (const prohibited of [
      'vat',
      'tax invoice',
      'withholding',
      'certified wiping',
      'nist',
      'dod',
    ])
      expect(serialized).not.toContain(prohibited);
    expect(await git(['status', '--short'])).toBe(beforeStatus);
    const afterCounts = (
      await database.pool.query(
        `SELECT (SELECT count(*)::int FROM jobs) jobs,(SELECT count(*)::int FROM ai_usage) ai,
          (SELECT coalesce(sum(used),0)::int FROM serp_provider_usage_periods) serp`,
      )
    ).rows[0];
    expect(afterCounts).toEqual(beforeCounts);
  });

  it('keeps the case waiting when required deterministic source context is absent', async () => {
    await registerCompanyFacts();
    const created = await createOwnerResearchCase(caseInput(), database.pool);
    const assessment = await reassessOwnerResearchCase(created.researchCase.id, database.pool, {
      sourceAllowedRoots: [parent],
    });
    expect(assessment.readyForAnalysis).toBe(false);
    expect(assessment.status).toBe('WAITING_FOR_EVIDENCE');
    expect(assessment.blockers).toContain('STORED_GSC_REQUIRED');
    expect(assessment.blockers).toContain('CLEAN_MAPPED_SOURCE_REQUIRED');
  });

  it('builds a bounded provenance-safe owner V3 context without SERP fabrication', async () => {
    const caseId = await readyResearchCase();
    const built = await buildOwnerResearchV3Context(caseId, database.pool);
    expect(built.packet.subject).toMatchObject({ type: 'OWNER_RESEARCH_CASE', id: caseId, query });
    expect(built.packet.gsc.metrics).toEqual({ clicks: 0, impressions: 15, ctr: 0, position: 5.6 });
    expect(built.packet.gsc.queryPageDistribution.map((item) => item.impressions)).toEqual([14, 1]);
    expect(built.packet.gsc.queryOwnershipInterpretation).toContain('UNPROVEN');
    expect(built.packet.ownerFacts).toHaveLength(13);
    expect(new Set(built.packet.ownerFacts.map((fact) => fact.provenance))).toEqual(
      new Set(['OWNER_CONFIRMED_DIRECT']),
    );
    expect(built.packet.evidence.serp).toBe('NONE');
    const serialized = JSON.stringify(built.packet).toLowerCase();
    expect(serialized).not.toContain('owner_observed_serp');
    expect(built.packet.excludedUnconfirmedClaims).toContain('VAT registration');
    expect(built.contextHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires exactly one subject and a fresh one-time owner authorization', async () => {
    const caseId = await readyResearchCase();
    await expect(
      enqueueJob(
        { type: 'GENERATE_SOURCE_CHANGE_PLAN', siteId, ownerResearchCaseId: caseId },
        database.db,
      ),
    ).rejects.toThrow('one-time owner authorization');
    await expect(
      enqueueJob(
        {
          type: 'GENERATE_SOURCE_CHANGE_PLAN',
          siteId,
          opportunityId: crypto.randomUUID(),
          ownerResearchCaseId: caseId,
          ownerAuthorizationId: crypto.randomUUID(),
        },
        database.db,
      ),
    ).rejects.toThrow('exactly one analysis subject');
    expect((await database.pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(0);
  });

  it('runs Owner Research V3 once, consumes authorization, and preserves Opportunity absence', async () => {
    const caseId = await readyResearchCase();
    const authorization = await recordOwnerResearchAiAuthorization(
      {
        caseId,
        authorizationRef: `test-owner-v3-${crypto.randomUUID()}`,
        authorizedBy: 'LOCAL_OWNER',
        ownerAuthorized: true,
      },
      database.pool,
    );
    await enqueueJob(
      {
        type: 'GENERATE_SOURCE_CHANGE_PLAN',
        siteId,
        ownerResearchCaseId: caseId,
        ownerAuthorizationId: authorization.id,
      },
      database.db,
    );
    const provider = new OwnerResearchProvider();
    expect(
      (
        await executeOne(
          'owner-v3-test-worker',
          database.pool,
          guard,
          undefined,
          undefined,
          provider,
        )
      ).state,
    ).toBe('SUCCEEDED');
    expect(provider.calls).toBe(1);
    expect(provider.lastInput?.subjectType).toBe('OWNER_RESEARCH_CASE');
    const panel = await sourcePanelForOwnerResearch(caseId, database.pool);
    expect(panel.latest).toMatchObject({
      opportunity_id: null,
      owner_research_case_id: caseId,
      subject_type: 'OWNER_RESEARCH_CASE',
      verdict: 'NEEDS_MORE_EVIDENCE',
    });
    const auth = (
      await database.pool.query('SELECT * FROM owner_research_ai_authorizations WHERE id=$1', [
        authorization.id,
      ])
    ).rows[0];
    expect(auth).toMatchObject({ status: 'CONSUMED', case_id: caseId });
    expect(
      (await database.pool.query('SELECT status FROM owner_research_cases WHERE id=$1', [caseId]))
        .rows[0].status,
    ).toBe('ANALYSIS_COMPLETE');
    expect(
      (
        await database.pool.query('SELECT * FROM ai_usage WHERE owner_research_case_id=$1', [
          caseId,
        ])
      ).rows,
    ).toHaveLength(1);
    await expect(
      enqueueJob(
        {
          type: 'GENERATE_SOURCE_CHANGE_PLAN',
          siteId,
          ownerResearchCaseId: caseId,
          ownerAuthorizationId: authorization.id,
        },
        database.db,
      ),
    ).resolves.toBeTruthy();
    expect(
      (
        await executeOne(
          'owner-v3-test-worker',
          database.pool,
          guard,
          undefined,
          undefined,
          provider,
        )
      ).state,
    ).toBe('FAILED');
    expect(provider.calls).toBe(1);
  });

  it('diagnoses only local SERP allowance metadata without attempting a provider call', async () => {
    await database.pool.query(
      `INSERT INTO serp_provider_configs(provider,enabled,allowance_type,configured_allowance,priority,capabilities)
       VALUES('SERPAPI',true,'CREDIT_POOL',1,10,'{}')`,
    );
    await database.pool.query(
      `INSERT INTO serp_provider_usage_periods(provider,period_start,configured_allowance,used,reserved)
       VALUES('SERPAPI',now()-interval '1 day',1,1,0)`,
    );
    const before = await database.pool.query(`SELECT count(*)::int count FROM serp_api_captures`);
    const result = await diagnoseSerpQuota(database.pool);
    expect(result).toMatchObject({ state: 'INTERNAL_DISABLED', externalProviderQuota: 'UNKNOWN' });
    const after = await database.pool.query(`SELECT count(*)::int count FROM serp_api_captures`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
