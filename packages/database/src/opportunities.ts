import type { Pool } from 'pg';
import { getDatabase } from './index';
import {
  OPPORTUNITY_ENGINE_VERSION,
  type GeneratedOpportunity,
  type OpportunityInput,
} from '@seo-agent/opportunity-engine';

export type OpportunityContext = {
  siteId: string;
  crawlRunId: string;
  propertyId: string;
  gscSyncReference: string;
  lastFinalizedDate: string;
};

export async function opportunityContext(siteId: string, pool: Pool): Promise<OpportunityContext> {
  const result = await pool.query(
    `SELECT $1::uuid site_id,
      (SELECT id FROM crawl_runs WHERE site_id=$1 AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1) crawl_run_id,
      s.property_id,s.last_sync_run_id gsc_sync_reference,
      to_char(s.last_finalized_date,'YYYY-MM-DD') last_finalized_date
     FROM gsc_sync_summaries s
     WHERE s.site_id=$1 AND s.latest_status IN ('SUCCEEDED','PARTIAL')`,
    [siteId],
  );
  const row = result.rows[0];
  if (!row?.crawl_run_id)
    throw Object.assign(new Error('A successful crawl is required'), { code: 'CRAWL_REQUIRED' });
  if (!row?.property_id || !row?.gsc_sync_reference || !row?.last_finalized_date)
    throw Object.assign(new Error('Valid Search Console data is required'), {
      code: 'GSC_DATA_REQUIRED',
    });
  return {
    siteId,
    crawlRunId: String(row.crawl_run_id),
    propertyId: String(row.property_id),
    gscSyncReference: String(row.gsc_sync_reference),
    lastFinalizedDate: String(row.last_finalized_date),
  };
}

export async function createOpportunityRun(jobId: string, context: OpportunityContext, pool: Pool) {
  const result = await pool.query(
    `INSERT INTO opportunity_runs(site_id,job_id,crawl_run_id,gsc_sync_reference,status,engine_version)
     VALUES($1,$2,$3,$4,'RUNNING',$5)
     ON CONFLICT(job_id) DO UPDATE SET status='RUNNING',failure_code=NULL,failure_summary=NULL,
       started_at=now(),finished_at=NULL,updated_at=now()
     RETURNING *`,
    [
      context.siteId,
      jobId,
      context.crawlRunId,
      context.gscSyncReference,
      OPPORTUNITY_ENGINE_VERSION,
    ],
  );
  return result.rows[0];
}

export async function loadOpportunityInput(
  context: OpportunityContext,
  pool: Pool,
): Promise<OpportunityInput> {
  const params = [
    context.siteId,
    context.propertyId,
    context.lastFinalizedDate,
    context.crawlRunId,
  ];
  const [queries, pages, overlaps, unmapped] = await Promise.all([
    pool.query(
      `WITH query_metrics AS MATERIALIZED (
         SELECT query,
          sum(clicks) FILTER (WHERE metric_date>$3::date-28)::float8 current_clicks,
          sum(impressions) FILTER (WHERE metric_date>$3::date-28)::float8 current_impressions,
          CASE WHEN sum(impressions) FILTER (WHERE metric_date>$3::date-28)>0
            THEN sum(position*impressions) FILTER (WHERE metric_date>$3::date-28)::float8 /
                 sum(impressions) FILTER (WHERE metric_date>$3::date-28) ELSE 0 END current_position,
          sum(clicks) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 previous_clicks,
          sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 previous_impressions,
          CASE WHEN sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)>0
            THEN sum(position*impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 /
                 sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28) ELSE 0 END previous_position
         FROM gsc_query_metrics WHERE site_id=$1 AND property_id=$2 AND metric_date>$3::date-56
         GROUP BY query
       ), page_agg AS MATERIALIZED (
         SELECT query,page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
          CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
         FROM gsc_query_page_metrics
         WHERE site_id=$1 AND property_id=$2 AND metric_date>$3::date-28
         GROUP BY query,page
       ), primary_page AS MATERIALIZED (
         SELECT DISTINCT ON(query) query,page,clicks,impressions,position
         FROM page_agg ORDER BY query,impressions DESC,clicks DESC,position ASC,page ASC
       ), issue_agg AS MATERIALIZED (
         SELECT url,array_agg(DISTINCT rule_code ORDER BY rule_code) issue_codes
         FROM seo_issues WHERE crawl_run_id=$4 GROUP BY url
       )
       SELECT q.*,p.page,m.reason mapping_reason,cp.status_code,cp.indexable,
        COALESCE(i.issue_codes,'{}') issue_codes
       FROM query_metrics q LEFT JOIN primary_page p USING(query)
       LEFT JOIN gsc_page_crawl_mappings m ON m.site_id=$1 AND m.property_id=$2 AND m.gsc_page=p.page
       LEFT JOIN crawl_pages cp ON cp.id=m.crawl_page_id
       LEFT JOIN issue_agg i ON i.url=cp.url
       WHERE COALESCE(q.current_impressions,0)>0
       ORDER BY q.current_impressions DESC,q.query LIMIT 10000`,
      params,
    ),
    pool.query(
      `WITH page_metrics AS MATERIALIZED (
         SELECT page,
          sum(clicks) FILTER (WHERE metric_date>$3::date-28)::float8 current_clicks,
          sum(impressions) FILTER (WHERE metric_date>$3::date-28)::float8 current_impressions,
          CASE WHEN sum(impressions) FILTER (WHERE metric_date>$3::date-28)>0
            THEN sum(position*impressions) FILTER (WHERE metric_date>$3::date-28)::float8 /
                 sum(impressions) FILTER (WHERE metric_date>$3::date-28) ELSE 0 END current_position,
          sum(clicks) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 previous_clicks,
          sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 previous_impressions,
          CASE WHEN sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)>0
            THEN sum(position*impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28)::float8 /
                 sum(impressions) FILTER (WHERE metric_date>$3::date-56 AND metric_date<=$3::date-28) ELSE 0 END previous_position
         FROM gsc_page_metrics WHERE site_id=$1 AND property_id=$2 AND metric_date>$3::date-56
         GROUP BY page
       ), issue_agg AS MATERIALIZED (
         SELECT url,array_agg(DISTINCT rule_code ORDER BY rule_code) issue_codes
         FROM seo_issues WHERE crawl_run_id=$4 GROUP BY url
       )
       SELECT p.*,m.reason mapping_reason,cp.status_code,cp.indexable,cp.in_sitemap,
        COALESCE(i.issue_codes,'{}') issue_codes
       FROM page_metrics p
       LEFT JOIN gsc_page_crawl_mappings m ON m.site_id=$1 AND m.property_id=$2 AND m.gsc_page=p.page
       LEFT JOIN crawl_pages cp ON cp.id=m.crawl_page_id
       LEFT JOIN issue_agg i ON i.url=cp.url
       WHERE COALESCE(p.current_impressions,0)>0
       ORDER BY p.current_impressions DESC,p.page LIMIT 5000`,
      params,
    ),
    pool.query(
      `WITH page_agg AS MATERIALIZED (
         SELECT query,page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
          CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
         FROM gsc_query_page_metrics
         WHERE site_id=$1 AND property_id=$2 AND metric_date>$3::date-28
         GROUP BY query,page
       ), ranked AS MATERIALIZED (
         SELECT *,sum(impressions) OVER(PARTITION BY query) total_impressions,
          sum(clicks) OVER(PARTITION BY query) total_clicks,
          row_number() OVER(PARTITION BY query ORDER BY impressions DESC,clicks DESC,page) rank
         FROM page_agg
       )
       SELECT query,max(total_clicks)::float8 total_clicks,max(total_impressions)::float8 total_impressions,
        jsonb_agg(jsonb_build_object('page',page,'clicks',clicks,'impressions',impressions,'position',position)
          ORDER BY impressions DESC,clicks DESC,page) FILTER(WHERE rank<=5) pages
       FROM ranked WHERE impressions>=10
       GROUP BY query HAVING count(*)>=2 AND max(total_impressions)>=40
       ORDER BY max(total_impressions) DESC,query LIMIT 200`,
      params.slice(0, 3),
    ),
    pool.query(
      `WITH page_metrics AS MATERIALIZED (
         SELECT page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
          CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
         FROM gsc_page_metrics
         WHERE site_id=$1 AND property_id=$2 AND metric_date>$3::date-28
         GROUP BY page
       )
       SELECT p.*,CASE
         WHEN EXISTS(SELECT 1 FROM crawl_pages cp WHERE cp.crawl_run_id=$4 AND
           rtrim(cp.url,'/')=rtrim(p.page,'/') AND cp.url<>p.page) THEN 'REDIRECT_VARIANT'
         ELSE 'OTHER' END classification
       FROM page_metrics p LEFT JOIN gsc_page_crawl_mappings m
        ON m.site_id=$1 AND m.property_id=$2 AND m.gsc_page=p.page
       WHERE m.id IS NULL AND p.impressions>0
       ORDER BY p.impressions DESC,p.page LIMIT 100`,
      params,
    ),
  ]);
  const metric = (row: Record<string, unknown>, prefix: string) => ({
    clicks: Number(row[`${prefix}_clicks`] ?? row.clicks ?? 0),
    impressions: Number(row[`${prefix}_impressions`] ?? row.impressions ?? 0),
    position: Number(row[`${prefix}_position`] ?? row.position ?? 0),
  });
  return {
    siteId: context.siteId,
    queries: queries.rows.map((row) => ({
      query: row.query,
      page: row.page ?? undefined,
      current: metric(row, 'current'),
      previous: Number(row.previous_impressions ?? 0) ? metric(row, 'previous') : undefined,
      mappingReason: row.mapping_reason ?? undefined,
      crawlStatus: row.status_code,
      indexable: row.indexable ?? undefined,
      issueCodes: row.issue_codes ?? [],
    })),
    pages: pages.rows.map((row) => ({
      page: row.page,
      current: metric(row, 'current'),
      previous: Number(row.previous_impressions ?? 0) ? metric(row, 'previous') : undefined,
      mappingReason: row.mapping_reason ?? undefined,
      crawlStatus: row.status_code,
      indexable: row.indexable ?? undefined,
      inSitemap: row.in_sitemap ?? undefined,
      issueCodes: row.issue_codes ?? [],
    })),
    overlaps: overlaps.rows.map((row) => ({
      query: row.query,
      totalClicks: Number(row.total_clicks),
      totalImpressions: Number(row.total_impressions),
      pages: row.pages ?? [],
    })),
    unmapped: unmapped.rows.map((row) => ({
      page: row.page,
      current: metric(row, ''),
      classification: row.classification,
    })),
  };
}

export async function persistOpportunityResult(
  runId: string,
  siteId: string,
  generated: {
    opportunities: GeneratedOpportunity[];
    candidatesGenerated: number;
    opportunitiesSuppressed: number;
    suppressionCounts: Record<string, number>;
  },
  durationMs: number,
  pool: Pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT fingerprint,status FROM opportunities WHERE site_id=$1 AND engine_version=$2`,
      [siteId, OPPORTUNITY_ENGINE_VERSION],
    );
    const known = new Map(existing.rows.map((row) => [row.fingerprint, row.status]));
    let created = 0;
    let updated = 0;
    for (const item of generated.opportunities) {
      if (known.has(item.fingerprint)) updated++;
      else created++;
      await client.query(
        `INSERT INTO opportunities(site_id,kind,entity_type,url,query,title,summary,priority,priority_label,
          confidence,score,status,evidence,score_components,fingerprint,engine_version,generation_run_id,
          first_detected_at,last_detected_at,missing_run_count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN',$12,$13,$14,$15,$16,now(),now(),0)
         ON CONFLICT(site_id,engine_version,fingerprint) DO UPDATE SET
          entity_type=excluded.entity_type,url=excluded.url,query=excluded.query,title=excluded.title,
          summary=excluded.summary,priority=excluded.priority,priority_label=excluded.priority_label,
          confidence=excluded.confidence,score=excluded.score,evidence=excluded.evidence,
          score_components=excluded.score_components,generation_run_id=excluded.generation_run_id,
          last_detected_at=now(),missing_run_count=0,resolved_at=NULL,
          status=CASE WHEN opportunities.status='DISMISSED' THEN 'DISMISSED' ELSE 'OPEN' END,
          updated_at=now()`,
        [
          siteId,
          item.type,
          item.entityType,
          item.url ?? null,
          item.query ?? null,
          item.title,
          item.summary,
          item.priority === 'HIGH' ? 3 : item.priority === 'MEDIUM' ? 2 : 1,
          item.priority,
          item.confidence,
          item.score,
          JSON.stringify({ ...item.evidence, unknown: item.unknown }),
          JSON.stringify(item.scoreComponents),
          item.fingerprint,
          item.engineVersion,
          runId,
        ],
      );
    }
    const fingerprints = generated.opportunities.map((item) => item.fingerprint);
    const missing = await client.query(
      `UPDATE opportunities SET missing_run_count=missing_run_count+1,
        status=CASE WHEN missing_run_count+1>=2 THEN 'RESOLVED' ELSE status END,
        resolved_at=CASE WHEN missing_run_count+1>=2 THEN now() ELSE resolved_at END,updated_at=now()
       WHERE site_id=$1 AND engine_version=$2 AND status IN ('OPEN','MONITOR')
        AND NOT(fingerprint=ANY($3::text[])) RETURNING status`,
      [siteId, OPPORTUNITY_ENGINE_VERSION, fingerprints],
    );
    const resolved = missing.rows.filter((row) => row.status === 'RESOLVED').length;
    await client.query(
      `UPDATE opportunity_runs SET status='SUCCEEDED',candidates_generated=$2,
        opportunities_created=$3,opportunities_updated=$4,opportunities_resolved=$5,
        opportunities_suppressed=$6,suppression_counts=$7,duration_ms=$8,
        finished_at=now(),updated_at=now() WHERE id=$1`,
      [
        runId,
        generated.candidatesGenerated,
        created,
        updated,
        resolved,
        generated.opportunitiesSuppressed,
        JSON.stringify(generated.suppressionCounts),
        durationMs,
      ],
    );
    await client.query('COMMIT');
    return { created, updated, resolved, final: generated.opportunities.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function finishOpportunityRunFailure(
  runId: string,
  status: 'FAILED' | 'CANCELLED',
  code: string,
  summary: string,
  pool: Pool,
) {
  await pool.query(
    `UPDATE opportunity_runs SET status=$2,failure_code=$3,failure_summary=$4,
      finished_at=now(),updated_at=now() WHERE id=$1`,
    [runId, status, code, summary.slice(0, 500)],
  );
}

export async function dismissOpportunity(id: string, pool = getDatabase().pool) {
  const result = await pool.query(
    `UPDATE opportunities SET status='DISMISSED',dismissed_at=now(),updated_at=now()
     WHERE id=$1 RETURNING site_id`,
    [id],
  );
  return result.rows[0];
}

export async function listOpportunities(
  filters: {
    siteId?: string;
    priority?: string;
    type?: string;
    status?: string;
    query?: string;
    url?: string;
  } = {},
  pool = getDatabase().pool,
) {
  const started = performance.now();
  const result = await pool.query(
    `SELECT o.id,o.site_id,s.name site_name,o.kind,o.entity_type,o.url,o.query,o.title,o.summary,
      o.priority_label,o.confidence,o.score,o.status,o.evidence,o.first_detected_at,o.last_detected_at
     FROM opportunities o JOIN sites s ON s.id=o.site_id
     WHERE ($1='' OR o.site_id=$1::uuid) AND ($2='' OR o.priority_label=$2)
      AND ($3='' OR o.kind=$3) AND ($4='' OR o.status=$4)
      AND ($5='' OR o.query ILIKE '%'||$5||'%') AND ($6='' OR o.url ILIKE '%'||$6||'%')
     ORDER BY o.score DESC,o.last_detected_at DESC,o.id LIMIT 100`,
    [
      filters.siteId ?? '',
      filters.priority ?? '',
      filters.type ?? '',
      filters.status ?? 'OPEN',
      filters.query ?? '',
      filters.url ?? '',
    ],
  );
  const counts = await pool.query(
    `SELECT priority_label,count(*)::int count FROM opportunities
     WHERE status='OPEN' AND ($1='' OR site_id=$1::uuid) GROUP BY priority_label`,
    [filters.siteId ?? ''],
  );
  const sites = await pool.query(
    'SELECT id,name FROM sites WHERE active=true ORDER BY name LIMIT 100',
  );
  return {
    rows: result.rows,
    counts: Object.fromEntries(counts.rows.map((row) => [row.priority_label, row.count])),
    sites: sites.rows,
    timingMs: performance.now() - started,
  };
}

export async function opportunityDetail(id: string, pool = getDatabase().pool) {
  const started = performance.now();
  const result = await pool.query(
    `SELECT o.*,s.name site_name FROM opportunities o JOIN sites s ON s.id=o.site_id WHERE o.id=$1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const queryKinds = new Set(['STRIKING_DISTANCE_QUERY', 'LOW_CTR_QUERY', 'DECLINING_QUERY']);
  const overlapKind = row.kind === 'QUERY_PAGE_OVERLAP_CANDIDATE';
  const metricTable = queryKinds.has(row.kind)
    ? 'gsc_query_metrics'
    : overlapKind
      ? 'gsc_query_page_metrics'
      : 'gsc_page_metrics';
  const metricPredicate = queryKinds.has(row.kind) || overlapKind ? 'm.query=$2' : 'm.page=$2';
  const metricValue = queryKinds.has(row.kind) || overlapKind ? row.query : row.url;
  const [issues, metrics] = await Promise.all([
    pool.query(
      `SELECT rule_code,severity,title,detail FROM seo_issues
       WHERE site_id=$1 AND url=$2 AND crawl_run_id=(
         SELECT crawl_run_id FROM opportunity_runs WHERE id=$3
       ) ORDER BY detected_at DESC LIMIT 20`,
      [row.site_id, row.url ?? '', row.generation_run_id],
    ),
    pool.query(
      `WITH cutoff AS (
         SELECT last_finalized_date FROM gsc_sync_summaries WHERE site_id=$1
       )
       SELECT sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
        CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,
        CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
       FROM ${metricTable} m CROSS JOIN cutoff c
       WHERE m.site_id=$1 AND ${metricPredicate}
         AND m.metric_date>c.last_finalized_date-28`,
      [row.site_id, metricValue ?? ''],
    ),
  ]);
  return {
    opportunity: row,
    relatedIssues: issues.rows,
    relatedGsc: metrics.rows[0],
    timingMs: performance.now() - started,
  };
}

export async function siteOpportunitySummary(siteId: string, pool = getDatabase().pool) {
  const started = performance.now();
  const [counts, top, latestRun, activeJob] = await Promise.all([
    pool.query(
      `SELECT count(*)::int open,
        count(*) FILTER(WHERE priority_label='HIGH')::int high,
        count(*) FILTER(WHERE priority_label='MEDIUM')::int medium,
        count(*) FILTER(WHERE priority_label='LOW')::int low
       FROM opportunities WHERE site_id=$1 AND status='OPEN'`,
      [siteId],
    ),
    pool.query(
      `SELECT id,kind,priority_label,confidence,score,url,query,title FROM opportunities
       WHERE site_id=$1 AND status='OPEN' ORDER BY score DESC,last_detected_at DESC LIMIT 3`,
      [siteId],
    ),
    pool.query(`SELECT * FROM opportunity_runs WHERE site_id=$1 ORDER BY created_at DESC LIMIT 1`, [
      siteId,
    ]),
    pool.query(
      `SELECT id,status FROM jobs WHERE site_id=$1 AND type='GENERATE_OPPORTUNITIES'
       AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1`,
      [siteId],
    ),
  ]);
  return {
    counts: counts.rows[0],
    top: top.rows,
    latestRun: latestRun.rows[0] ?? null,
    activeJob: activeJob.rows[0] ?? null,
    timingMs: performance.now() - started,
  };
}

export async function dashboardTopOpportunities(pool = getDatabase().pool) {
  const started = performance.now();
  const result = await pool.query(
    `SELECT o.id,o.kind,o.priority_label,o.score,o.query,o.url,s.name site_name
     FROM opportunities o JOIN sites s ON s.id=o.site_id
     WHERE o.status='OPEN' ORDER BY o.score DESC,o.last_detected_at DESC LIMIT 5`,
  );
  return { rows: result.rows, timingMs: performance.now() - started };
}
