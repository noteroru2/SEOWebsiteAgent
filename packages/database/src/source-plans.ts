import type { Pool } from 'pg';
import { calculateCostMicros } from '@seo-agent/ai';
import {
  SOURCE_PLAN_PROMPT_VERSION,
  SOURCE_PLAN_EVIDENCE_PROMPT_VERSION,
  SOURCE_PLAN_SCHEMA_VERSION,
  sourceEvidenceHash,
  type RepositoryState,
  type RouteMapping,
  type SourceContext,
  type SourcePlanProviderResult,
} from '@seo-agent/source-understanding';
import { getDatabase } from './index';

function dollarsMicros(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Math.round(parsed * 1_000_000);
}

export async function connectSourceRepository(
  input: { siteId: string; localRoot: string; expectedRemote?: string; defaultBranch?: string },
  pool: Pool = getDatabase().pool,
) {
  const existing = await pool.query(
    'SELECT id FROM site_repositories WHERE site_id=$1 ORDER BY created_at LIMIT 1',
    [input.siteId],
  );
  const result = existing.rows[0]
    ? await pool.query(
        `UPDATE site_repositories SET local_path=$2,repository_type='LOCAL_GIT',expected_remote=$3,default_branch=$4,enabled=true,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          existing.rows[0].id,
          input.localRoot,
          input.expectedRemote ?? null,
          input.defaultBranch ?? null,
        ],
      )
    : await pool.query(
        `INSERT INTO site_repositories(site_id,local_path,repository_type,expected_remote,default_branch,enabled) VALUES($1,$2,'LOCAL_GIT',$3,$4,true) RETURNING *`,
        [input.siteId, input.localRoot, input.expectedRemote ?? null, input.defaultBranch ?? null],
      );
  await pool.query(
    `INSERT INTO system_events(source,level,event,detail) VALUES('source','INFO','SOURCE_REPOSITORY_CONNECTED',jsonb_build_object('siteId',$1::text,'repositoryId',$2::text))`,
    [input.siteId, result.rows[0].id],
  );
  return result.rows[0] as Record<string, unknown>;
}

export async function sourceRepositoryForSite(siteId: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT * FROM site_repositories WHERE site_id=$1 AND enabled=true ORDER BY updated_at DESC LIMIT 1`,
    [siteId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

export async function persistSourceRefresh(
  input: {
    siteId: string;
    repositoryId: string;
    siteUrl: string;
    state: RepositoryState;
    mappings: RouteMapping[];
    durationMs: number;
  },
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      'SELECT head_sha FROM site_repositories WHERE id=$1 FOR UPDATE',
      [input.repositoryId],
    );
    await client.query(
      `UPDATE site_repositories SET head_sha=$2,current_branch=$3,origin_url=$4,worktree_clean=$5,tracked_file_count=$6,last_refreshed_at=now(),updated_at=now() WHERE id=$1`,
      [
        input.repositoryId,
        input.state.headSha,
        input.state.branch,
        input.state.originUrl,
        input.state.clean,
        input.state.trackedFiles.length,
      ],
    );
    const seen: string[] = [];
    for (const mapping of input.mappings) {
      const routeUrl = mapping.routePath.startsWith('/')
        ? new URL(mapping.routePath, input.siteUrl).toString()
        : input.siteUrl;
      seen.push(mapping.routePath);
      await client.query(
        `INSERT INTO source_route_mappings(site_id,repository_id,route_url,route_path,mapping_status,primary_source_path,related_source_paths,repository_head_sha,mapping_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
        ON CONFLICT(repository_id,route_path) DO UPDATE SET route_url=excluded.route_url,mapping_status=excluded.mapping_status,primary_source_path=excluded.primary_source_path,related_source_paths=excluded.related_source_paths,repository_head_sha=excluded.repository_head_sha,mapping_evidence=excluded.mapping_evidence,updated_at=now()`,
        [
          input.siteId,
          input.repositoryId,
          routeUrl,
          mapping.routePath,
          mapping.status,
          mapping.primarySourcePath,
          JSON.stringify(mapping.relatedSourcePaths),
          input.state.headSha,
          JSON.stringify(mapping.evidence),
        ],
      );
    }
    if (seen.length)
      await client.query(
        'DELETE FROM source_route_mappings WHERE repository_id=$1 AND NOT(route_path=ANY($2::text[]))',
        [input.repositoryId, seen],
      );
    else
      await client.query('DELETE FROM source_route_mappings WHERE repository_id=$1', [
        input.repositoryId,
      ]);
    if (previous.rows[0]?.head_sha && previous.rows[0].head_sha !== input.state.headSha) {
      const stale = await client.query(
        `UPDATE source_change_plans p SET status='STALE',stale_at=now(),updated_at=now() FROM source_plan_runs r WHERE p.run_id=r.id AND r.repository_id=$1 AND p.status IN ('READY_FOR_REVIEW','APPROVED') AND r.repository_head_sha<>$2 RETURNING p.id`,
        [input.repositoryId, input.state.headSha],
      );
      if (stale.rowCount)
        await client.query(
          `INSERT INTO system_events(source,level,event,detail) VALUES('source','WARN','SOURCE_PLAN_STALE',jsonb_build_object('repositoryId',$1::text,'count',$2::int))`,
          [input.repositoryId, stale.rowCount],
        );
    }
    await client.query(
      `INSERT INTO system_events(source,level,event,detail) VALUES('source','INFO','SOURCE_REPOSITORY_REFRESH_COMPLETED',jsonb_build_object('siteId',$1::text,'repositoryId',$2::text,'routes',$3::int,'durationMs',$4::int))`,
      [input.siteId, input.repositoryId, input.mappings.length, input.durationMs],
    );
    await client.query('COMMIT');
    return { routes: input.mappings.length, headSha: input.state.headSha };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function collectUrls(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      into.add(new URL(value).toString());
    } catch {
      // Invalid evidence values are ignored rather than interpreted as paths.
    }
  } else if (Array.isArray(value)) for (const item of value) collectUrls(item, into);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value as Record<string, unknown>)) collectUrls(item, into);
  return into;
}

export async function opportunitySourceInput(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const opportunityResult = await pool.query(
    `SELECT o.*,s.url site_url,s.name site_name FROM opportunities o JOIN sites s ON s.id=o.site_id WHERE o.id=$1`,
    [opportunityId],
  );
  const opportunity = opportunityResult.rows[0];
  if (!opportunity)
    throw Object.assign(new Error('Opportunity not found'), { code: 'OPPORTUNITY_REQUIRED' });
  if (!['OPEN', 'MONITOR'].includes(opportunity.status))
    throw Object.assign(new Error('Opportunity is not eligible'), {
      code: 'SOURCE_PLAN_NOT_ELIGIBLE',
    });
  const repository = await sourceRepositoryForSite(opportunity.site_id, pool);
  if (!repository?.head_sha || repository.worktree_clean !== true)
    throw Object.assign(new Error('Validated clean repository refresh required'), {
      code: 'SOURCE_REPOSITORY_REFRESH_REQUIRED',
    });
  const ai = await pool.query(
    `SELECT a.id analysis_id,a.prompt_version,a.schema_version,r.result,r.summary,r.verdict FROM ai_analysis_runs a JOIN ai_recommendations r ON r.analysis_run_id=COALESCE(a.reused_run_id,a.id) WHERE a.opportunity_id=$1 AND a.status IN ('SUCCEEDED','REUSED') ORDER BY a.created_at DESC LIMIT 1`,
    [opportunityId],
  );
  if (!ai.rows[0])
    throw Object.assign(new Error('Accepted Batch 5 analysis required'), {
      code: 'BATCH5_ANALYSIS_REQUIRED',
    });
  const urls = collectUrls(opportunity.evidence);
  if (opportunity.url) urls.add(new URL(opportunity.url, opportunity.site_url).toString());
  const routes = [...urls].map((url) => decodeURI(new URL(url).pathname).replace(/\/$/, '') || '/');
  const mappings = await pool.query(
    `SELECT * FROM source_route_mappings WHERE repository_id=$1 AND (route_path=ANY($2::text[]) OR trim(trailing '/' from route_path)=ANY($3::text[])) ORDER BY route_path`,
    [repository.id, routes, routes.map((x) => x.replace(/\/$/, '') || '/')],
  );
  return { opportunity, batch5: ai.rows[0], repository, routes, mappings: mappings.rows };
}

export async function createSourcePlanRun(
  input: {
    jobId: string;
    source: Awaited<ReturnType<typeof opportunitySourceInput>>;
    context: SourceContext;
    evidencePacket?: unknown;
  },
  pool: Pool = getDatabase().pool,
) {
  const hash = sourceEvidenceHash({
    opportunityFingerprint: input.source.opportunity.fingerprint,
    batch5AnalysisId: input.source.batch5.analysis_id,
    context: input.context,
    evidencePacket: input.evidencePacket,
  });
  const promptVersion = input.evidencePacket
    ? SOURCE_PLAN_EVIDENCE_PROMPT_VERSION
    : SOURCE_PLAN_PROMPT_VERSION;
  const reuse = await pool.query(
    `SELECT r.id run_id,p.* FROM source_plan_runs r JOIN source_change_plans p ON p.run_id=r.id WHERE r.source_evidence_hash=$1 AND r.status='SUCCEEDED' ORDER BY r.created_at DESC LIMIT 1`,
    [hash],
  );
  if (reuse.rows[0]) {
    const run = await pool.query(
      `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,job_id,reused_run_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,source_context,finished_at) VALUES($1,$2,$3,$4,$5,'REUSED','gpt-5.6-terra','medium',$6,$7,$8,$9,$10::jsonb,now()) RETURNING *`,
      [
        input.source.opportunity.site_id,
        input.source.opportunity.id,
        input.source.repository.id,
        input.jobId,
        reuse.rows[0].run_id,
        promptVersion,
        SOURCE_PLAN_SCHEMA_VERSION,
        input.source.repository.head_sha,
        hash,
        JSON.stringify(input.context),
      ],
    );
    return { run: run.rows[0], reused: reuse.rows[0] };
  }
  const month = await pool.query(
    `SELECT COALESCE(sum(cost_micros),0)::bigint global_cost,COALESCE(sum(cost_micros) FILTER(WHERE site_id=$1),0)::bigint site_cost FROM ai_usage WHERE created_at>=date_trunc('month',now())`,
    [input.source.opportunity.site_id],
  );
  const estimated = dollarsMicros(process.env.AI_SOURCE_PLAN_MAX_COST_USD, 0.5);
  if (
    Number(month.rows[0].global_cost) + estimated >
      dollarsMicros(process.env.AI_GLOBAL_MONTHLY_BUDGET_USD, 28.5) ||
    Number(month.rows[0].site_cost) + estimated >
      dollarsMicros(process.env.AI_SITE_MONTHLY_BUDGET_USD, 8.5)
  )
    throw Object.assign(new Error('AI source-plan budget exceeded'), {
      code: 'AI_BUDGET_EXCEEDED',
    });
  const run = await pool.query(
    `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,job_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,source_context) VALUES($1,$2,$3,$4,'RUNNING','gpt-5.6-terra','medium',$5,$6,$7,$8,$9::jsonb) RETURNING *`,
    [
      input.source.opportunity.site_id,
      input.source.opportunity.id,
      input.source.repository.id,
      input.jobId,
      promptVersion,
      SOURCE_PLAN_SCHEMA_VERSION,
      input.source.repository.head_sha,
      hash,
      JSON.stringify(input.context),
    ],
  );
  return { run: run.rows[0], reused: null };
}

export async function persistSourcePlanSuccess(
  run: Record<string, unknown>,
  analysis: SourcePlanProviderResult,
  pool: Pool = getDatabase().pool,
) {
  const cost = calculateCostMicros(
    String(run.model),
    analysis.inputTokens,
    analysis.cachedInputTokens,
    analysis.outputTokens,
  );
  if (cost > dollarsMicros(process.env.AI_SOURCE_PLAN_MAX_COST_USD, 0.5))
    throw Object.assign(new Error('Source plan exceeded per-plan budget'), {
      code: 'AI_PER_ANALYSIS_BUDGET_EXCEEDED',
    });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await client.query(
      `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,batch5_reconciliation,summary,structured_output,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'READY_FOR_REVIEW') RETURNING *`,
      [
        run.id,
        run.site_id,
        run.opportunity_id,
        analysis.result.verdict,
        analysis.result.confidence,
        analysis.result.batch5_reconciliation,
        analysis.result.summary,
        JSON.stringify(analysis.result),
      ],
    );
    await client.query(
      `UPDATE source_plan_runs SET status='SUCCEEDED',input_tokens=$2,cached_input_tokens=$3,output_tokens=$4,actual_cost_micros=$5,provider_request_id=$6,latency_ms=$7,finished_at=now(),updated_at=now() WHERE id=$1`,
      [
        run.id,
        analysis.inputTokens,
        analysis.cachedInputTokens,
        analysis.outputTokens,
        cost,
        analysis.providerRequestId,
        analysis.latencyMs,
      ],
    );
    await client.query(
      `INSERT INTO ai_usage(site_id,job_id,opportunity_id,source_plan_run_id,provider,model,prompt_version,input_tokens,cached_input_tokens,output_tokens,cost_micros,status) VALUES($1,$2,$3,$4,'openai',$5,$6,$7,$8,$9,$10,'SUCCEEDED')`,
      [
        run.site_id,
        run.job_id,
        run.opportunity_id,
        run.id,
        run.model,
        run.prompt_version,
        analysis.inputTokens,
        analysis.cachedInputTokens,
        analysis.outputTokens,
        cost,
      ],
    );
    await client.query(
      `INSERT INTO system_events(source,level,event,detail) VALUES('source','INFO','SOURCE_PLAN_COMPLETED',jsonb_build_object('runId',$1::text,'planId',$2::text,'costMicros',$3::int))`,
      [run.id, plan.rows[0].id, cost],
    );
    await client.query('COMMIT');
    return { plan: plan.rows[0], costMicros: cost };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failSourcePlanRun(
  runId: string,
  code: string,
  summary: string,
  pool: Pool = getDatabase().pool,
) {
  await pool.query(
    `UPDATE source_plan_runs SET status='FAILED',failure_code=$2,failure_summary=$3,finished_at=now(),updated_at=now() WHERE id=$1`,
    [runId, code, summary.slice(0, 300)],
  );
}

export async function sourcePanelForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const [opportunity, plan, active] = await Promise.all([
    pool.query(
      `SELECT o.*,s.url site_url,r.id repository_id,r.head_sha,r.current_branch,r.worktree_clean
       FROM opportunities o JOIN sites s ON s.id=o.site_id
       LEFT JOIN site_repositories r ON r.site_id=o.site_id AND r.enabled=true
       WHERE o.id=$1 ORDER BY r.updated_at DESC LIMIT 1`,
      [opportunityId],
    ),
    pool.query(
      `SELECT p.*,r.repository_head_sha,r.actual_cost_micros,r.source_context FROM source_change_plans p JOIN source_plan_runs r ON r.id=p.run_id WHERE p.opportunity_id=$1 ORDER BY p.created_at DESC LIMIT 1`,
      [opportunityId],
    ),
    pool.query(
      `SELECT id,status FROM jobs WHERE type='GENERATE_SOURCE_CHANGE_PLAN' AND payload->>'opportunityId'=$1 AND status IN ('QUEUED','RUNNING') LIMIT 1`,
      [opportunityId],
    ),
  ]);
  const item = opportunity.rows[0];
  let mapping: Record<string, unknown> | null = null;
  if (item?.repository_id) {
    const urls = collectUrls(item.evidence);
    if (item.url) urls.add(new URL(item.url, item.site_url).toString());
    const routes = [...urls].map(
      (url) => decodeURI(new URL(url).pathname).replace(/\/$/, '') || '/',
    );
    const mapped = await pool.query(
      `SELECT * FROM source_route_mappings WHERE repository_id=$1
       AND trim(trailing '/' from route_path)=ANY($2::text[]) ORDER BY route_path`,
      [item.repository_id, routes.map((route) => route.replace(/\/$/, '') || '/')],
    );
    if (mapped.rows.length === 1) mapping = { ...mapped.rows[0], ...item };
    else if (mapped.rows.length > 1)
      mapping = {
        ...item,
        route_path: mapped.rows.map((row) => row.route_path).join(' | '),
        mapping_status: 'MULTI_FILE_COMPOSITION',
        primary_source_path: mapped.rows.map((row) => row.primary_source_path).join(' | '),
      };
  }
  return {
    mapping,
    latest: plan.rows[0] ?? null,
    activeJob: active.rows[0] ?? null,
    configured: Boolean(process.env.OPENAI_API_KEY),
  };
}

export async function siteSourceSummary(siteId: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT r.*,count(m.id)::int routes_mapped,count(m.id) FILTER(WHERE m.mapping_status IN ('UNRESOLVED','AMBIGUOUS'))::int unresolved_routes FROM site_repositories r LEFT JOIN source_route_mappings m ON m.repository_id=r.id WHERE r.site_id=$1 AND r.enabled=true GROUP BY r.id ORDER BY r.updated_at DESC LIMIT 1`,
    [siteId],
  );
  return result.rows[0] ?? null;
}

export async function listSourceApprovals(pool: Pool = getDatabase().pool) {
  const started = performance.now();
  const result = await pool.query(
    `SELECT p.*,s.name site_name,o.title opportunity_title,r.repository_head_sha,jsonb_array_length(COALESCE(p.structured_output->'change_items','[]')) files_affected FROM source_change_plans p JOIN sites s ON s.id=p.site_id JOIN opportunities o ON o.id=p.opportunity_id JOIN source_plan_runs r ON r.id=p.run_id WHERE p.status IN ('READY_FOR_REVIEW','APPROVED','STALE') ORDER BY p.created_at DESC LIMIT 100`,
  );
  return { rows: result.rows, timingMs: performance.now() - started };
}

export async function decideSourcePlan(
  planId: string,
  decision: 'APPROVED' | 'REJECTED',
  pool: Pool = getDatabase().pool,
) {
  const result = await pool.query(
    `UPDATE source_change_plans SET status=$2,approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END,rejected_at=CASE WHEN $2='REJECTED' THEN now() ELSE rejected_at END,updated_at=now() WHERE id=$1 AND status='READY_FOR_REVIEW' RETURNING *`,
    [planId, decision],
  );
  if (!result.rows[0])
    throw Object.assign(new Error('Plan is not ready for review'), {
      code: 'SOURCE_PLAN_NOT_REVIEWABLE',
    });
  await pool.query(
    `INSERT INTO system_events(source,level,event,detail) VALUES('source','INFO',$2,jsonb_build_object('planId',$1::text))`,
    [planId, decision === 'APPROVED' ? 'SOURCE_PLAN_APPROVED' : 'SOURCE_PLAN_REJECTED'],
  );
  return result.rows[0];
}
