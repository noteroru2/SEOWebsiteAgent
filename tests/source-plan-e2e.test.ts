import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  connectSourceRepository,
  createDatabase,
  createSite,
  decideSourcePlan,
  enqueueJob,
  ensureEvidenceRequest,
  listSourceApprovals,
  opportunitySourceInput,
  persistSourceRefresh,
  resolveEvidenceRequest,
  sourcePanelForOpportunity,
} from '@seo-agent/database';
import {
  deriveAstroProjectMappings,
  buildSourceContext,
  inspectRepository,
  SOURCE_PLAN_EVIDENCE_PROMPT_VERSION,
  type SourcePlanProviderInput,
  type SourcePlanProvider,
} from '@seo-agent/source-understanding';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const execute = promisify(execFile);
const database = createDatabase(requireTestDatabaseUrl());
const guard = new ResourceGuard(
  {},
  {
    collect: async () => ({
      freeMemoryMb: 2000,
      freeDiskMb: 10_000,
      loadPerCpu: 0,
      platform: 'linux',
    }),
  },
);
let parent = '';
let repository = '';
let siteId = '';
let opportunityId = '';

class FakeSourceProvider implements SourcePlanProvider {
  calls = 0;
  lastInput: SourcePlanProviderInput | null = null;
  async generate(input: Parameters<SourcePlanProvider['generate']>[0]) {
    this.calls++;
    this.lastInput = input;
    const file = input.context.files[0]!;
    return {
      result: {
        verdict: 'PROPOSE_CHANGE' as const,
        confidence: 'MEDIUM' as const,
        batch5_reconciliation: 'REFINED' as const,
        summary: 'Review the bounded introduction while preserving the existing H1.',
        source_findings: [
          {
            path: file.path,
            start_line: 1,
            end_line: 1,
            finding: 'The supplied page begins with an About heading.',
            confidence: 'HIGH' as const,
          },
        ],
        change_items: [
          {
            change_type: 'ADJUST_INTRO' as const,
            path: file.path,
            start_line: 1,
            end_line: 1,
            section: 'Introduction',
            current_state: 'A brief introduction is present.',
            proposed_change:
              'Review whether the introduction should distinguish the company-history role.',
            reason: 'The source confirms this page has a distinct informational role.',
            risk: 'LOW' as const,
            expected_goal: 'Clarify the page role without changing URLs.',
            requires_owner_approval: true as const,
          },
        ],
        preserve: [
          { path: file.path, section: 'H1', reason: 'The heading identifies the page role.' },
        ],
        additional_evidence_needed: [],
        unknowns: [],
      },
      providerRequestId: `fake-source-${this.calls}`,
      inputTokens: 900,
      cachedInputTokens: 200,
      outputTokens: 220,
      latencyMs: 20,
    };
  }
}

async function git(...args: string[]) {
  return execute('git', args, { cwd: repository, windowsHide: true, shell: false });
}
async function seed() {
  const site = await createSite(
    { name: 'Source Fixture', url: 'https://source.example.com/' },
    database.db,
  );
  siteId = site.id;
  const generation = (
    await database.pool.query(
      `INSERT INTO opportunity_runs(site_id,status,engine_version,finished_at) VALUES($1,'SUCCEEDED','opportunity-engine-v1',now()) RETURNING id`,
      [siteId],
    )
  ).rows[0];
  opportunityId = (
    await database.pool.query(
      `INSERT INTO opportunities(site_id,kind,entity_type,url,query,title,summary,priority,priority_label,confidence,score,status,evidence,score_components,fingerprint,engine_version,generation_run_id) VALUES($1,'LOW_CTR_QUERY','QUERY','https://source.example.com/about','brand','About opportunity','Review page role',2,'MEDIUM','MEDIUM',60,'OPEN',$2,'{}','source-fixture','opportunity-engine-v1',$3) RETURNING id`,
      [
        siteId,
        JSON.stringify({ page: 'https://source.example.com/about', unknown: 'Causation unknown' }),
        generation.id,
      ],
    )
  ).rows[0].id;
  const analysis = (
    await database.pool.query(
      `INSERT INTO ai_analysis_runs(site_id,opportunity_id,status,analysis_key,evidence_hash,opportunity_fingerprint,prompt_version,schema_version,model,reasoning_effort,finished_at) VALUES($1,$2,'SUCCEEDED','key','hash','source-fixture','seo-recommendation-prompt-v2','schema','gpt-5.6-terra','medium',now()) RETURNING id`,
      [siteId, opportunityId],
    )
  ).rows[0];
  await database.pool.query(
    `INSERT INTO ai_recommendations(analysis_run_id,site_id,opportunity_id,verdict,confidence,summary,result) VALUES($1,$2,$3,'INVESTIGATE','MEDIUM','Review content',$4::jsonb)`,
    [analysis.id, siteId, opportunityId, JSON.stringify({ recommended_actions: [] })],
  );
  const state = await inspectRepository(repository, [parent]);
  const repo = await connectSourceRepository(
    { siteId, localRoot: state.root, defaultBranch: state.branch ?? undefined },
    database.pool,
  );
  await persistSourceRefresh(
    {
      siteId,
      repositoryId: String(repo.id),
      siteUrl: site.url,
      state,
      mappings: await deriveAstroProjectMappings(state),
      durationMs: 1,
    },
    database.pool,
  );
}
async function run(provider: FakeSourceProvider) {
  await enqueueJob({ type: 'GENERATE_SOURCE_CHANGE_PLAN', siteId, opportunityId }, database.db);
  return executeOne('source-test-worker', database.pool, guard, undefined, undefined, provider);
}

async function addCompleteSourceEvidence() {
  const source = await opportunitySourceInput(opportunityId, database.pool);
  const row = source.mappings[0]!;
  const context = await buildSourceContext(await inspectRepository(repository, [parent]), {
    routePath: row.route_path,
    status: row.mapping_status,
    primarySourcePath: row.primary_source_path,
    relatedSourcePaths: row.related_source_paths ?? [],
    evidence: row.mapping_evidence ?? {},
  });
  const request = await ensureEvidenceRequest(
    {
      opportunityId,
      type: 'TARGETED_SOURCE_CONTEXT',
      requirement: 'Bounded source context',
      reason: 'Required for v3',
      source: 'SOURCE_REPOSITORY',
    },
    database.pool,
  );
  await resolveEvidenceRequest(
    request.id,
    'SOURCE_REPOSITORY',
    { ...context, materialPrimaryTruncation: false },
    undefined,
    database.pool,
  );
}

async function runEvidence(provider: FakeSourceProvider) {
  await enqueueJob(
    {
      type: 'GENERATE_SOURCE_CHANGE_PLAN',
      siteId,
      opportunityId,
      evidenceReevaluation: true,
    },
    database.db,
  );
  return executeOne(
    'source-evidence-test-worker',
    database.pool,
    guard,
    undefined,
    undefined,
    provider,
  );
}

describe('source-plan worker and approval pipeline', () => {
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
    parent = await mkdtemp(path.join(tmpdir(), 'source-plan-db-'));
    repository = path.join(parent, 'repo');
    await mkdir(path.join(repository, 'src/pages'), { recursive: true });
    await writeFile(
      path.join(repository, 'src/pages/about.astro'),
      '<h1>About</h1>\n<p>Company history.</p>\n',
    );
    await git('init');
    await git('config', 'user.email', 'fixture@example.com');
    await git('config', 'user.name', 'Fixture');
    await git('add', '--', '.');
    await git('commit', '-m', 'fixture');
  });
  beforeEach(async () => {
    process.env.SOURCE_REPO_ALLOWED_ROOTS = parent;
    await resetTestDatabase(database.pool);
    await seed();
  });
  afterAll(async () => {
    await database.pool.end();
    if (parent) await rm(parent, { recursive: true, force: true });
  });
  it('persists a validated source-grounded plan and one usage row', async () => {
    const provider = new FakeSourceProvider();
    expect((await run(provider)).state).toBe('SUCCEEDED');
    expect(provider.calls).toBe(1);
    const panel = await sourcePanelForOpportunity(opportunityId, database.pool);
    expect(panel.latest).toMatchObject({
      status: 'READY_FOR_REVIEW',
      verdict: 'PROPOSE_CHANGE',
      batch5_reconciliation: 'REFINED',
    });
    expect(
      (await database.pool.query('SELECT * FROM ai_usage WHERE source_plan_run_id IS NOT NULL'))
        .rows,
    ).toHaveLength(1);
  });
  it('runs an owner-triggered v3 re-evaluation with a fake provider only when evidence is complete', async () => {
    await addCompleteSourceEvidence();
    const provider = new FakeSourceProvider();
    expect((await runEvidence(provider)).state).toBe('SUCCEEDED');
    expect(provider.calls).toBe(1);
    expect(provider.lastInput?.evidencePacket).toBeTruthy();
    expect(
      (
        await database.pool.query(
          `SELECT prompt_version FROM source_plan_runs ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0].prompt_version,
    ).toBe(SOURCE_PLAN_EVIDENCE_PROMPT_VERSION);
  });
  it('stops before the provider when required owner evidence is still open', async () => {
    await addCompleteSourceEvidence();
    await ensureEvidenceRequest(
      {
        opportunityId,
        type: 'MANUAL_SERP_OBSERVATION',
        requirement: 'Owner SERP observation',
        reason: 'Required for v3',
        source: 'OWNER',
      },
      database.pool,
    );
    const provider = new FakeSourceProvider();
    expect((await runEvidence(provider)).state).toBe('FAILED');
    expect(provider.calls).toBe(0);
  });
  it('reuses identical successful evidence without another provider call', async () => {
    const provider = new FakeSourceProvider();
    await run(provider);
    await run(provider);
    expect(provider.calls).toBe(1);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_plan_runs ORDER BY created_at`)
      ).rows.map((row) => row.status),
    ).toEqual(['SUCCEEDED', 'REUSED']);
  });
  it('approval is database-only and audited', async () => {
    const provider = new FakeSourceProvider();
    await run(provider);
    const before = await git('status', '--porcelain=v1');
    const plan = (await listSourceApprovals(database.pool)).rows[0];
    await decideSourcePlan(plan.id, 'APPROVED', database.pool);
    expect((await sourcePanelForOpportunity(opportunityId, database.pool)).latest.status).toBe(
      'APPROVED',
    );
    expect(
      (
        await database.pool.query(
          `SELECT event FROM system_events WHERE event='SOURCE_PLAN_APPROVED'`,
        )
      ).rows,
    ).toHaveLength(1);
    expect((await git('status', '--porcelain=v1')).stdout).toBe(before.stdout);
  });
  it('rejection preserves the plan', async () => {
    await run(new FakeSourceProvider());
    const plan = (await listSourceApprovals(database.pool)).rows[0];
    await decideSourcePlan(plan.id, 'REJECTED', database.pool);
    expect(
      (await database.pool.query('SELECT status FROM source_change_plans WHERE id=$1', [plan.id]))
        .rows[0].status,
    ).toBe('REJECTED');
  });
  it('a repository HEAD change makes an approved plan stale without regeneration', async () => {
    await run(new FakeSourceProvider());
    const plan = (await listSourceApprovals(database.pool)).rows[0];
    await decideSourcePlan(plan.id, 'APPROVED', database.pool);
    await writeFile(path.join(repository, 'src/pages/about.astro'), '<h1>About us</h1>\n');
    await git('add', '--', '.');
    await git('commit', '-m', 'fixture update');
    const state = await inspectRepository(repository, [parent]);
    const repo = (
      await database.pool.query('SELECT id FROM site_repositories WHERE site_id=$1', [siteId])
    ).rows[0];
    await persistSourceRefresh(
      {
        siteId,
        repositoryId: repo.id,
        siteUrl: 'https://source.example.com/',
        state,
        mappings: await deriveAstroProjectMappings(state),
        durationMs: 1,
      },
      database.pool,
    );
    expect(
      (await database.pool.query('SELECT status FROM source_change_plans WHERE id=$1', [plan.id]))
        .rows[0].status,
    ).toBe('STALE');
  });
});
