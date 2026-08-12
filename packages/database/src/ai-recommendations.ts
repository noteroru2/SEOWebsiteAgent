import type { Pool } from 'pg';
import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  analysisKey,
  buildProviderInput,
  calculateCostMicros,
  evidenceHash,
  estimateMaximumCostMicros,
  type AiModelConfig,
  type ProviderAnalysis,
  type RecommendationContext,
} from '@seo-agent/ai';
import { getDatabase } from './index';

const dollarsToMicros = (value: string | undefined, fallback: number) => {
  const dollars = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(dollars) || dollars < 0)
    throw Object.assign(new Error('Invalid AI budget configuration'), {
      code: 'AI_CONFIG_INVALID',
    });
  return Math.floor(dollars * 1_000_000);
};
const clip = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max);
};

export function resolveRecommendationLocale(input: {
  pageLanguage?: unknown;
  configuredLocale?: string;
  query?: unknown;
}) {
  const pageLanguage = clip(input.pageLanguage, 32)?.trim();
  if (pageLanguage) return pageLanguage;
  const configuredLocale = input.configuredLocale?.trim();
  if (configuredLocale) return configuredLocale;
  return typeof input.query === 'string' && /[\u0E00-\u0E7F]/u.test(input.query) ? 'th' : 'en';
}

export async function loadRecommendationContext(
  opportunityId: string,
  siteId: string,
  pool: Pool = getDatabase().pool,
): Promise<RecommendationContext> {
  const found = await pool.query(
    `SELECT o.*,s.name site_name,s.url site_url
     FROM opportunities o JOIN sites s ON s.id=o.site_id
     WHERE o.id=$1 AND o.site_id=$2`,
    [opportunityId, siteId],
  );
  const opportunity = found.rows[0];
  if (!opportunity)
    throw Object.assign(new Error('Opportunity not found'), { code: 'OPPORTUNITY_NOT_FOUND' });
  if (!['OPEN', 'MONITOR'].includes(opportunity.status))
    throw Object.assign(new Error('Only open or monitored opportunities can be analyzed'), {
      code: 'OPPORTUNITY_NOT_ANALYZABLE',
    });
  const [pageResult, relatedResult, windowResult] = await Promise.all([
    opportunity.url
      ? pool.query(
          `SELECT cp.* FROM crawl_pages cp
           WHERE cp.crawl_run_id=(SELECT crawl_run_id FROM opportunity_runs WHERE id=$2)
            AND (cp.url=$1 OR cp.final_url=$1 OR cp.canonical_url=$1)
           ORDER BY CASE WHEN cp.url=$1 THEN 0 WHEN cp.final_url=$1 THEN 1 ELSE 2 END LIMIT 1`,
          [opportunity.url, opportunity.generation_run_id],
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT kind,url,query,priority_label,confidence,score,left(summary,400) summary
       FROM opportunities WHERE site_id=$1 AND id<>$2 AND status IN ('OPEN','MONITOR')
        AND (($3::text IS NOT NULL AND url=$3) OR ($4::text IS NOT NULL AND query=$4))
       ORDER BY score DESC LIMIT 5`,
      [siteId, opportunityId, opportunity.url, opportunity.query],
    ),
    pool.query(
      `SELECT to_char(s.last_finalized_date-27,'YYYY-MM-DD') current_start_date,
        to_char(s.last_finalized_date,'YYYY-MM-DD') current_end_date,
        28 current_days,r.status data_state,r.coverage_status coverage,
        COALESCE(p.previous_days,0)>=28 previous_available,
        CASE WHEN COALESCE(p.previous_days,0)>=28
          THEN to_char(s.last_finalized_date-55,'YYYY-MM-DD') END previous_start_date,
        CASE WHEN COALESCE(p.previous_days,0)>=28
          THEN to_char(s.last_finalized_date-28,'YYYY-MM-DD') END previous_end_date,
        CASE WHEN COALESCE(p.previous_days,0)>=28 THEN 28 END previous_days
       FROM opportunity_runs o
       JOIN gsc_sync_runs r ON r.id=o.gsc_sync_reference
       JOIN gsc_sync_summaries s ON s.site_id=o.site_id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT metric_date)::int previous_days
         FROM gsc_daily_site_metrics m
         WHERE m.site_id=o.site_id AND m.property_id=r.property_id
           AND m.metric_date BETWEEN s.last_finalized_date-55 AND s.last_finalized_date-28
       ) p ON true
       WHERE o.id=$1 AND s.last_finalized_date IS NOT NULL LIMIT 1`,
      [opportunity.generation_run_id],
    ),
  ]);
  const page = pageResult.rows[0];
  let issues: Array<{ code: string; severity: string; title: string }> = [];
  if (page) {
    const issueResult = await pool.query(
      `SELECT rule_code code,severity,title FROM seo_issues
       WHERE crawl_page_id=$1 ORDER BY severity,rule_code LIMIT 20`,
      [page.id],
    );
    issues = issueResult.rows.map((row) => ({ ...row, title: clip(row.title, 300) ?? '' }));
  }
  const evidence = (opportunity.evidence ?? {}) as Record<string, unknown>;
  const locale = resolveRecommendationLocale({
    pageLanguage: page?.language,
    configuredLocale: process.env.SEO_RECOMMENDATION_LOCALE,
    query: opportunity.query,
  });
  const window = windowResult.rows[0];
  return {
    site: { name: opportunity.site_name, baseUrl: opportunity.site_url, businessFacts: [], locale },
    opportunity: {
      id: opportunity.id,
      type: opportunity.kind,
      priority: opportunity.priority_label,
      confidence: opportunity.confidence,
      score: opportunity.score,
      fingerprint: opportunity.fingerprint,
      title: opportunity.title,
      summary: opportunity.summary,
      url: opportunity.url ?? undefined,
      query: opportunity.query ?? undefined,
      evidence,
      unknown: typeof evidence.unknown === 'string' ? evidence.unknown : undefined,
    },
    page: page
      ? {
          url: page.url,
          statusCode: page.status_code,
          title: clip(page.title, 500),
          metaDescription: clip(page.meta_description, 1_000),
          primaryH1: clip(page.primary_h1, 500),
          canonicalUrl: page.canonical_url,
          indexable: page.indexable,
          indexabilityReasons: page.indexability_reasons,
          wordCount: page.word_count,
          internalLinksCount: page.internal_links_count,
          inSitemap: page.in_sitemap,
          issues,
        }
      : undefined,
    search: {
      current: evidence.current ?? evidence,
      previous: evidence.previous,
      mappingReason:
        typeof evidence.mappingReason === 'string' ? evidence.mappingReason : undefined,
      relatedSignals: relatedResult.rows,
      currentWindow: window
        ? {
            startDate: window.current_start_date,
            endDate: window.current_end_date,
            days: window.current_days,
            dataState: window.data_state,
            coverage: window.coverage,
          }
        : undefined,
      previousWindow: window
        ? {
            available: window.previous_available,
            startDate: window.previous_start_date,
            endDate: window.previous_end_date,
            days: window.previous_days,
          }
        : undefined,
    },
    contentReviewRequired: true,
  };
}

export async function prepareAiAnalysis(
  input: {
    jobId: string;
    siteId: string;
    opportunityId: string;
    force: boolean;
    config: AiModelConfig;
  },
  pool: Pool = getDatabase().pool,
) {
  const context = await loadRecommendationContext(input.opportunityId, input.siteId, pool);
  const key = analysisKey(context, input.config);
  const hash = evidenceHash(context);
  if (!input.force) {
    const reusable = await pool.query(
      `SELECT id FROM ai_analysis_runs WHERE analysis_key=$1 AND status='SUCCEEDED'
       ORDER BY created_at DESC LIMIT 1`,
      [key],
    );
    if (reusable.rows[0]) {
      const reused = await pool.query(
        `INSERT INTO ai_analysis_runs(site_id,opportunity_id,job_id,reused_run_id,status,analysis_key,
          evidence_hash,opportunity_fingerprint,prompt_version,schema_version,model,reasoning_effort,
          context_chars,started_at,finished_at)
         VALUES($1,$2,$3,$4,'REUSED',$5,$6,$7,$8,$9,$10,$11,$12,now(),now()) RETURNING *`,
        [
          input.siteId,
          input.opportunityId,
          input.jobId,
          reusable.rows[0].id,
          key,
          hash,
          context.opportunity.fingerprint,
          AI_PROMPT_VERSION,
          AI_SCHEMA_VERSION,
          input.config.model,
          input.config.reasoningEffort,
          buildProviderInput(context).length,
        ],
      );
      return { context, run: reused.rows[0], reused: true, reusedRunId: reusable.rows[0].id };
    }
  }
  const estimatedCost = estimateMaximumCostMicros(context, input.config);
  const [spend] = (
    await pool.query(
      `SELECT COALESCE(sum(cost_micros),0)::bigint global_cost,
        COALESCE(sum(cost_micros) FILTER(WHERE site_id=$1),0)::bigint site_cost
       FROM ai_usage WHERE created_at>=date_trunc('month',now())`,
      [input.siteId],
    )
  ).rows;
  const globalLimit = dollarsToMicros(process.env.AI_GLOBAL_MONTHLY_BUDGET_USD, 28.5);
  const siteLimit = dollarsToMicros(process.env.AI_SITE_MONTHLY_BUDGET_USD, 8.5);
  const analysisLimit = dollarsToMicros(process.env.AI_MAX_ANALYSIS_COST_USD, 0.25);
  const budgetExceeded =
    estimatedCost > analysisLimit ||
    Number(spend.global_cost) + estimatedCost > globalLimit ||
    Number(spend.site_cost) + estimatedCost > siteLimit;
  const inserted = await pool.query(
    `INSERT INTO ai_analysis_runs(site_id,opportunity_id,job_id,status,analysis_key,evidence_hash,
      opportunity_fingerprint,prompt_version,schema_version,model,reasoning_effort,estimated_cost_micros,
      context_chars,failure_code,failure_summary,started_at,finished_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16) RETURNING *`,
    [
      input.siteId,
      input.opportunityId,
      input.jobId,
      budgetExceeded ? 'FAILED' : 'RUNNING',
      key,
      hash,
      context.opportunity.fingerprint,
      AI_PROMPT_VERSION,
      AI_SCHEMA_VERSION,
      input.config.model,
      input.config.reasoningEffort,
      estimatedCost,
      buildProviderInput(context).length,
      budgetExceeded ? 'AI_BUDGET_EXCEEDED' : null,
      budgetExceeded ? 'Configured AI budget would be exceeded' : null,
      budgetExceeded ? new Date() : null,
    ],
  );
  if (budgetExceeded)
    throw Object.assign(new Error('Configured AI budget would be exceeded'), {
      code: 'AI_BUDGET_EXCEEDED',
      analysisRunId: inserted.rows[0].id,
    });
  return { context, run: inserted.rows[0], reused: false };
}

export async function persistAiAnalysisSuccess(
  run: Record<string, unknown>,
  analysis: ProviderAnalysis,
  pool: Pool = getDatabase().pool,
) {
  const cost = calculateCostMicros(
    String(run.model),
    analysis.inputTokens,
    analysis.cachedInputTokens,
    analysis.outputTokens,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ai_recommendations(analysis_run_id,site_id,opportunity_id,verdict,confidence,summary,result)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        run.id,
        run.site_id,
        run.opportunity_id,
        analysis.result.verdict,
        analysis.result.confidence,
        analysis.result.summary,
        JSON.stringify(analysis.result),
      ],
    );
    await client.query(
      `UPDATE ai_analysis_runs SET status='SUCCEEDED',actual_cost_micros=$2,input_tokens=$3,
        cached_input_tokens=$4,output_tokens=$5,provider_request_id=$6,latency_ms=$7,
        finished_at=now(),updated_at=now() WHERE id=$1`,
      [
        run.id,
        cost,
        analysis.inputTokens,
        analysis.cachedInputTokens,
        analysis.outputTokens,
        analysis.providerRequestId ?? null,
        analysis.latencyMs,
      ],
    );
    await client.query(
      `INSERT INTO ai_usage(site_id,job_id,opportunity_id,analysis_run_id,provider,model,prompt_version,
        input_tokens,cached_input_tokens,output_tokens,cost_micros,status)
       VALUES($1,$2,$3,$4,'openai',$5,$6,$7,$8,$9,$10,'SUCCEEDED')`,
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
    await client.query('COMMIT');
    return { costMicros: cost };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistAiAnalysisFailure(
  runId: string,
  code: string,
  summary: string,
  pool: Pool = getDatabase().pool,
) {
  await pool.query(
    `UPDATE ai_analysis_runs SET status=CASE WHEN $2='AI_CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END,
      failure_code=$2,failure_summary=$3,finished_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
    [runId, code, summary.slice(0, 300)],
  );
}

export async function recordAiFailedRequest(
  run: Record<string, unknown>,
  pool: Pool = getDatabase().pool,
) {
  await pool.query(
    `INSERT INTO ai_usage(site_id,job_id,opportunity_id,analysis_run_id,provider,model,prompt_version,status)
     VALUES($1,$2,$3,$4,'openai',$5,$6,'FAILED')`,
    [run.site_id, run.job_id, run.opportunity_id, run.id, run.model, run.prompt_version],
  );
}

export async function aiPanelForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const [latest, active] = await Promise.all([
    pool.query(
      `SELECT a.*,r.verdict,r.confidence recommendation_confidence,r.summary recommendation_summary,r.result,
        COALESCE(a.reused_run_id,a.id) source_run_id
       FROM ai_analysis_runs a
       LEFT JOIN ai_recommendations r ON r.analysis_run_id=COALESCE(a.reused_run_id,a.id)
       WHERE a.opportunity_id=$1 ORDER BY a.created_at DESC LIMIT 1`,
      [opportunityId],
    ),
    pool.query(
      `SELECT id,status FROM jobs WHERE type='ANALYZE_OPPORTUNITY'
        AND payload->>'opportunityId'=$1 AND status IN ('QUEUED','RUNNING') LIMIT 1`,
      [opportunityId],
    ),
  ]);
  return {
    latest: latest.rows[0] ?? null,
    activeJob: active.rows[0] ?? null,
    configured: Boolean(process.env.OPENAI_API_KEY),
  };
}

export async function aiSpendSummary(siteId?: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT count(*) FILTER(WHERE a.status IN ('SUCCEEDED','REUSED'))::int analyses,
      count(*) FILTER(WHERE a.status='SUCCEEDED')::int provider_calls,
      COALESCE(avg(a.actual_cost_micros) FILTER(WHERE a.status='SUCCEEDED'),0)::float8 average_cost_micros,
      COALESCE(sum(a.actual_cost_micros),0)::bigint cost_micros
     FROM ai_analysis_runs a WHERE a.created_at>=date_trunc('month',now())
      AND ($1::text IS NULL OR a.site_id=$1::uuid)`,
    [siteId ?? null],
  );
  return {
    ...result.rows[0],
    budgetMicros: dollarsToMicros(
      siteId ? process.env.AI_SITE_MONTHLY_BUDGET_USD : process.env.AI_GLOBAL_MONTHLY_BUDGET_USD,
      siteId ? 8.5 : 28.5,
    ),
  };
}
