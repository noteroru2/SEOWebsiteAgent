import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { addCalendarDays, calendarDateRange } from '@seo-agent/shared';
import {
  buildSourceContext,
  buildTargetedMultiRouteContext,
  inspectRepository,
  type RouteMapping,
} from '@seo-agent/source-understanding';
import { getDatabase } from './index';
import { opportunitySourceInput } from './source-plans';

export const evidenceRequestTypes = [
  'GSC_COMPARISON_WINDOW',
  'GSC_QUERY_PAGE_DISTRIBUTION',
  'TARGETED_SOURCE_CONTEXT',
  'MANUAL_SERP_OBSERVATION',
  'OWNER_BUSINESS_CONFIRMATION',
  'OWNER_QUERY_OWNERSHIP',
] as const;
export type EvidenceRequestType = (typeof evidenceRequestTypes)[number];
export type EvidenceCompleteness =
  'INCOMPLETE' | 'INTERNALLY_RESOLVED' | 'OWNER_INPUT_REQUIRED' | 'READY_FOR_REEVALUATION';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['createdAt', 'updatedAt'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function evidenceHash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function equalGscWindows(lastFinalizedDate: string, days = 28) {
  const currentEnd = lastFinalizedDate;
  const currentStart = addCalendarDays(currentEnd, -(days - 1));
  const previousEnd = addCalendarDays(currentStart, -1);
  const previousStart = addCalendarDays(previousEnd, -(days - 1));
  return {
    current: { start: currentStart, end: currentEnd, days },
    previous: { start: previousStart, end: previousEnd, days },
  };
}

export function missingDatesForWindow(
  window: { start: string; end: string },
  existingDates: Iterable<string>,
) {
  const existing = new Set(existingDates);
  return calendarDateRange(window.start, window.end).filter((date) => !existing.has(date));
}

export function safeMetricDelta(current: number, previous: number) {
  return {
    absolute: current - previous,
    relative: previous === 0 ? null : (current - previous) / previous,
  };
}

export function evidenceCompleteness(
  requests: Array<{ required: boolean; status: string; type: string }>,
): EvidenceCompleteness {
  const required = requests.filter((item) => item.required);
  if (!required.length) return 'INTERNALLY_RESOLVED';
  if (required.every((item) => ['RESOLVED', 'NOT_AVAILABLE'].includes(item.status)))
    return 'READY_FOR_REEVALUATION';
  if (
    required.some(
      (item) =>
        item.status === 'OPEN' &&
        !item.type.startsWith('OWNER_') &&
        item.type !== 'MANUAL_SERP_OBSERVATION',
    )
  )
    return 'INCOMPLETE';
  if (
    required.some((item) => item.status === 'OPEN' && item.type.startsWith('OWNER_')) ||
    required.some((item) => item.status === 'OPEN' && item.type === 'MANUAL_SERP_OBSERVATION')
  )
    return 'OWNER_INPUT_REQUIRED';
  return 'INCOMPLETE';
}

export async function ensureEvidenceRequest(
  input: {
    opportunityId: string;
    type: EvidenceRequestType;
    requirement: string;
    reason: string;
    source: string;
    required?: boolean;
  },
  pool: Pool = getDatabase().pool,
) {
  const result = await pool.query(
    `INSERT INTO evidence_requests(opportunity_id,type,requirement,reason,source,required)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(opportunity_id,type,requirement) WHERE status<>'SUPERSEDED'
     DO UPDATE SET reason=excluded.reason,source=excluded.source,required=excluded.required,updated_at=now()
     RETURNING *`,
    [
      input.opportunityId,
      input.type,
      input.requirement,
      input.reason,
      input.source,
      input.required ?? true,
    ],
  );
  return result.rows[0];
}

export async function resolveEvidenceRequest(
  requestId: string,
  sourceType: string,
  evidence: unknown,
  observedAt?: Date,
  pool: Pool = getDatabase().pool,
) {
  const item = await recordEvidenceItem(requestId, sourceType, evidence, observedAt, pool);
  await pool.query(`UPDATE evidence_requests SET status='RESOLVED',updated_at=now() WHERE id=$1`, [
    requestId,
  ]);
  return item;
}

export async function recordEvidenceItem(
  requestId: string,
  sourceType: string,
  evidence: unknown,
  observedAt?: Date,
  pool: Pool = getDatabase().pool,
) {
  const hash = evidenceHash(evidence);
  const item = await pool.query(
    `INSERT INTO evidence_items(request_id,source_type,evidence,evidence_hash,observed_at)
     VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(request_id,evidence_hash) DO UPDATE SET observed_at=excluded.observed_at
     RETURNING *`,
    [requestId, sourceType, JSON.stringify(evidence), hash, observedAt ?? null],
  );
  return item.rows[0];
}

export async function storeOwnerEvidence(
  input: {
    requestId: string;
    sourceType: 'OWNER_OBSERVED_SERP' | 'OWNER_CONFIRMED';
    evidence: unknown;
    observedAt?: Date;
  },
  pool: Pool = getDatabase().pool,
) {
  const request = await pool.query(
    `SELECT type FROM evidence_requests WHERE id=$1 AND status='OPEN'`,
    [input.requestId],
  );
  if (!request.rows[0]) throw new Error('Open evidence request required');
  const requestType = String(request.rows[0].type);
  if (
    (input.sourceType === 'OWNER_OBSERVED_SERP' && requestType !== 'MANUAL_SERP_OBSERVATION') ||
    (input.sourceType === 'OWNER_CONFIRMED' && !requestType.startsWith('OWNER_'))
  )
    throw new Error('Owner evidence type does not match the evidence request');
  return resolveEvidenceRequest(
    input.requestId,
    input.sourceType,
    input.evidence,
    input.observedAt,
    pool,
  );
}

async function metricsForWindow(
  pool: Pool,
  siteId: string,
  query: string,
  start: string,
  end: string,
) {
  const queryMetric = await pool.query(
    `SELECT coalesce(sum(clicks),0)::float8 clicks,coalesce(sum(impressions),0)::float8 impressions,
      CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,
      CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
     FROM gsc_query_metrics WHERE site_id=$1 AND query=$2 AND metric_date BETWEEN $3 AND $4`,
    [siteId, query, start, end],
  );
  const pages = await pool.query(
    `WITH rows AS (SELECT page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
       CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,
       CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
       FROM gsc_query_page_metrics WHERE site_id=$1 AND query=$2 AND metric_date BETWEEN $3 AND $4 GROUP BY page),
     totals AS (SELECT coalesce(sum(clicks),0) clicks,coalesce(sum(impressions),0) impressions FROM rows)
     SELECT rows.*,CASE WHEN totals.impressions>0 THEN rows.impressions/totals.impressions ELSE 0 END impression_share,
       CASE WHEN totals.clicks>0 THEN rows.clicks/totals.clicks ELSE 0 END click_share FROM rows,totals
     ORDER BY rows.impressions DESC,rows.clicks DESC,rows.page`,
    [siteId, query, start, end],
  );
  return { metrics: queryMetric.rows[0], pages: pages.rows };
}

export async function buildGscComparison(opportunityId: string, pool: Pool = getDatabase().pool) {
  const row = (
    await pool.query(
      `SELECT o.site_id,o.query,to_char(s.last_finalized_date,'YYYY-MM-DD') last_date
     FROM opportunities o JOIN gsc_sync_summaries s ON s.site_id=o.site_id WHERE o.id=$1`,
      [opportunityId],
    )
  ).rows[0];
  if (!row?.query || !row.last_date) throw new Error('Query and finalized GSC window required');
  const windows = equalGscWindows(row.last_date);
  const [current, previous] = await Promise.all([
    metricsForWindow(pool, row.site_id, row.query, windows.current.start, windows.current.end),
    metricsForWindow(pool, row.site_id, row.query, windows.previous.start, windows.previous.end),
  ]);
  const changes = Object.fromEntries(
    ['clicks', 'impressions', 'ctr', 'position'].map((key) => [
      key,
      safeMetricDelta(Number(current.metrics[key]), Number(previous.metrics[key])),
    ]),
  );
  return { windows, query: row.query, current, previous, changes };
}

export async function buildTargetedEvidence(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const source = await opportunitySourceInput(opportunityId, pool);
  const state = await inspectRepository(String(source.repository.local_path));
  const gscPages = await pool.query(
    `SELECT DISTINCT page FROM gsc_query_page_metrics WHERE site_id=$1 AND query=$2`,
    [source.opportunity.site_id, source.opportunity.query],
  );
  const observedRoutePaths = gscPages.rows.flatMap((row) => {
    try {
      return [decodeURI(new URL(row.page).pathname).replace(/\/$/, '') || '/'];
    } catch {
      return [];
    }
  });
  const mappedGscRoutes = observedRoutePaths.length
    ? (
        await pool.query(
          `SELECT * FROM source_route_mappings
           WHERE repository_id=$1 AND route_path=ANY($2::text[])
             AND mapping_status NOT IN ('UNRESOLVED','AMBIGUOUS') ORDER BY route_path`,
          [source.repository.id, observedRoutePaths],
        )
      ).rows
    : [];
  const selected = selectTargetedEvidenceRoutes({
    kind: source.opportunity.kind,
    query: source.opportunity.query,
    mappedGscRoutes,
  });
  const mappingByRoute = new Map(
    [...source.mappings, ...mappedGscRoutes].map((row) => [row.route_path, row]),
  );
  const requiredMappings = selected.routes.flatMap((route) => {
    const mapping = mappingByRoute.get(route);
    return mapping ? [mapping] : [];
  });
  const mappings = selected.applies
    ? requiredMappings
    : [...mappingByRoute.values()].filter((row) =>
        source.mappings.some((candidate) => candidate.route_path === row.route_path),
      );
  const contexts = [];
  for (const row of mappings) {
    const mapping: RouteMapping = {
      routePath: row.route_path,
      status: row.mapping_status,
      primarySourcePath: row.primary_source_path,
      relatedSourcePaths: row.related_source_paths ?? [],
      evidence: row.mapping_evidence ?? {},
    };
    contexts.push(await buildSourceContext(state, mapping));
  }
  if (!contexts.length) {
    return {
      repository: { headSha: state.headSha, branch: state.branch, clean: state.clean },
      routeMapping: null,
      files: [],
      totalCharacters: 0,
      redactions: 0,
      incompletePrimaryRoutes: selected.routes,
      missingRequiredRoutes: selected.missingRequirements,
      materialPrimaryTruncation: true,
      repositoryHeadSha: state.headSha,
    };
  }
  const targeted = buildTargetedMultiRouteContext(contexts);
  const missingRequiredRoutes = [
    ...selected.missingRequirements,
    ...selected.routes.filter((route) => !mappingByRoute.has(route)),
  ];
  return {
    ...targeted,
    missingRequiredRoutes,
    materialPrimaryTruncation:
      targeted.materialPrimaryTruncation || missingRequiredRoutes.length > 0,
    repositoryHeadSha: state.headSha,
  };
}

export function selectTargetedEvidenceRoutes(input: {
  kind: string;
  query: string;
  mappedGscRoutes: Array<{ route_path: string; primary_source_path?: string | null }>;
}) {
  const routes = input.mappedGscRoutes;
  if (
    input.kind === 'QUERY_PAGE_OVERLAP_CANDIDATE' &&
    input.query === 'ร้านรับซื้อโน๊ตบุ๊ค ใกล้ฉัน'
  ) {
    const required = [
      '/',
      '/รับซื้อ/รับซื้อโน๊ตบุ๊ค-อุบลราชธานี',
      '/พื้นที่ให้บริการ/บุรีรัมย์',
      '/พื้นที่ให้บริการ/ร้อยเอ็ด',
    ];
    const observed = new Set(routes.map((route) => route.route_path));
    return {
      applies: true,
      routes: required.filter((route) => observed.has(route)),
      missingRequirements: required.filter((route) => !observed.has(route)),
    };
  }
  if (input.query === 'ร้านรับซื้อโทรศัพท์ใกล้ฉัน') {
    const selected = routes.filter(
      (route) =>
        route.route_path === '/' || route.primary_source_path?.startsWith('src/content/services/'),
    );
    const selectedPaths = selected.map((route) => route.route_path);
    const missingRequirements = [
      ...(selectedPaths.includes('/') ? [] : ['homepage']),
      ...(selected.some((route) => route.primary_source_path?.startsWith('src/content/services/'))
        ? []
        : ['deterministically mapped phone/mobile service page']),
    ];
    return { applies: true, routes: selectedPaths, missingRequirements };
  }
  if (input.query === 'mac mini m4 มือสอง') {
    const selected = routes.filter(
      (route) =>
        route.primary_source_path?.startsWith('src/content/services/') ||
        route.primary_source_path?.startsWith('src/content/blog/'),
    );
    const selectedPaths = selected.map((route) => route.route_path);
    const missingRequirements = [
      ...(selected.some((route) => route.primary_source_path?.startsWith('src/content/services/'))
        ? []
        : ['deterministically mapped service page']),
      ...(selected.some((route) => route.primary_source_path?.startsWith('src/content/blog/'))
        ? []
        : ['deterministically mapped informational/article page']),
    ];
    return { applies: true, routes: selectedPaths, missingRequirements };
  }
  return { applies: false, routes: [] as string[], missingRequirements: [] as string[] };
}

export async function evidencePanelForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const result = await pool.query(
    `SELECT r.*,coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sourceType',i.source_type,'evidence',i.evidence,
      'evidenceHash',i.evidence_hash,'observedAt',i.observed_at,'createdAt',i.created_at)
      ORDER BY i.created_at,i.id) FILTER(WHERE i.id IS NOT NULL),'[]') items
     FROM evidence_requests r LEFT JOIN evidence_items i ON i.request_id=r.id
     WHERE r.opportunity_id=$1 AND r.status<>'SUPERSEDED' GROUP BY r.id ORDER BY r.created_at`,
    [opportunityId],
  );
  return { requests: result.rows, completeness: evidenceCompleteness(result.rows) };
}

export async function deterministicEvidencePacket(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const panel = await evidencePanelForOpportunity(opportunityId, pool);
  const byType = (type: string) =>
    panel.requests
      .filter((request) => request.type === type)
      .flatMap((request) => request.items.slice(-1));
  const packet = {
    currentGscWindow: byType('GSC_COMPARISON_WINDOW').map((item) => item.evidence.current),
    previousGscWindow: byType('GSC_COMPARISON_WINDOW').map((item) => item.evidence.previous),
    queryPageDistribution: byType('GSC_QUERY_PAGE_DISTRIBUTION').map((item) => item.evidence),
    targetedSourceContext: byType('TARGETED_SOURCE_CONTEXT').map((item) => item.evidence),
    manualSerpObservation: byType('MANUAL_SERP_OBSERVATION').map((item) => item.evidence),
    ownerBusinessConfirmation: byType('OWNER_BUSINESS_CONFIRMATION').map((item) => item.evidence),
    ownerQueryOwnership: byType('OWNER_QUERY_OWNERSHIP').map((item) => item.evidence),
    unresolvedEvidence: panel.requests
      .filter((request) => request.status === 'OPEN')
      .map((request) => ({ type: request.type, requirement: request.requirement })),
  };
  return { packet, evidencePacketHash: evidenceHash(packet), completeness: panel.completeness };
}

const sixEvidenceTargets = [
  {
    kind: 'LOW_CTR_QUERY',
    query: 'รับซื้อ ram',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_BUSINESS_CONFIRMATION'],
  },
  {
    kind: 'QUERY_PAGE_OVERLAP_CANDIDATE',
    query: 'ร้านรับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_BUSINESS_CONFIRMATION', 'OWNER_QUERY_OWNERSHIP'],
  },
  {
    kind: 'LOW_CTR_QUERY',
    query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_BUSINESS_CONFIRMATION'],
  },
  {
    kind: 'QUERY_PAGE_OVERLAP_CANDIDATE',
    query: 'อำพล เทรดดิ้ง',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_QUERY_OWNERSHIP'],
  },
  {
    kind: 'STRIKING_DISTANCE_QUERY',
    query: 'mac mini m4 มือสอง',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_QUERY_OWNERSHIP'],
  },
  {
    kind: 'STRIKING_DISTANCE_QUERY',
    query: 'ร้านรับซื้อโทรศัพท์ใกล้ฉัน',
    owner: ['MANUAL_SERP_OBSERVATION', 'OWNER_BUSINESS_CONFIRMATION', 'OWNER_QUERY_OWNERSHIP'],
  },
] as const;

export async function resolveInternalEvidenceForSix(pool: Pool = getDatabase().pool) {
  const output = [];
  for (const target of sixEvidenceTargets) {
    const opportunity = (
      await pool.query(
        `SELECT * FROM opportunities WHERE status='OPEN' AND kind=$1 AND query=$2 ORDER BY created_at DESC LIMIT 1`,
        [target.kind, target.query],
      )
    ).rows[0];
    if (!opportunity) throw new Error(`Evidence target missing: ${target.kind}/${target.query}`);
    const comparisonRequest = await ensureEvidenceRequest(
      {
        opportunityId: opportunity.id,
        type: 'GSC_COMPARISON_WINDOW',
        requirement:
          'Compare the current finalized window with the immediately preceding equal-size window.',
        reason: 'Distinguish a persistent signal from one-window variation.',
        source: 'GSC_PIPELINE',
      },
      pool,
    );
    const comparison = await buildGscComparison(opportunity.id, pool);
    const previousDates = await pool.query(
      `SELECT count(DISTINCT metric_date)::int dates FROM gsc_daily_site_metrics WHERE site_id=$1 AND metric_date BETWEEN $2 AND $3`,
      [opportunity.site_id, comparison.windows.previous.start, comparison.windows.previous.end],
    );
    if (previousDates.rows[0].dates === comparison.windows.previous.days)
      await resolveEvidenceRequest(
        comparisonRequest.id,
        'GSC_PIPELINE',
        {
          current: comparison.current,
          previous: comparison.previous,
          windows: comparison.windows,
          changes: comparison.changes,
        },
        undefined,
        pool,
      );

    const distributionRequest = await ensureEvidenceRequest(
      {
        opportunityId: opportunity.id,
        type: 'GSC_QUERY_PAGE_DISTRIBUTION',
        requirement: 'Compare current and previous query-to-page ownership distributions.',
        reason: 'Metrics describe distribution but do not prescribe ownership.',
        source: 'GSC_PIPELINE',
      },
      pool,
    );
    if (previousDates.rows[0].dates === comparison.windows.previous.days)
      await resolveEvidenceRequest(
        distributionRequest.id,
        'GSC_PIPELINE',
        {
          query: comparison.query,
          windows: comparison.windows,
          current: comparison.current.pages,
          previous: comparison.previous.pages,
        },
        undefined,
        pool,
      );

    const sourceRequest = await ensureEvidenceRequest(
      {
        opportunityId: opportunity.id,
        type: 'TARGETED_SOURCE_CONTEXT',
        requirement: 'Prioritize deterministic primary source for every affected route within 40K.',
        reason: 'Execution preparation requires route-specific source sufficiency.',
        source: 'SOURCE_REPOSITORY',
      },
      pool,
    );
    await pool.query(`UPDATE evidence_requests SET status='OPEN',updated_at=now() WHERE id=$1`, [
      sourceRequest.id,
    ]);
    const targeted = await buildTargetedEvidence(opportunity.id, pool);
    if (targeted.materialPrimaryTruncation)
      await recordEvidenceItem(sourceRequest.id, 'SOURCE_REPOSITORY', targeted, undefined, pool);
    else
      await resolveEvidenceRequest(
        sourceRequest.id,
        'SOURCE_REPOSITORY',
        targeted,
        undefined,
        pool,
      );

    for (const type of target.owner as readonly EvidenceRequestType[]) {
      const requirement =
        type === 'MANUAL_SERP_OBSERVATION'
          ? `Owner-observed SERP for “${target.query}”: location, device, displayed title/snippet, ranking URL, approximate position and features.`
          : type === 'OWNER_QUERY_OWNERSHIP'
            ? `Owner confirmation of preferred page role/ownership for “${target.query}”.`
            : `Owner confirmation of relevant service area, branch, appointment, accepted-product and valuation facts for “${target.query}”.`;
      await ensureEvidenceRequest(
        {
          opportunityId: opportunity.id,
          type,
          requirement,
          reason: 'This fact cannot be inferred from GSC metrics or source text.',
          source: 'OWNER',
        },
        pool,
      );
    }
    output.push({
      opportunityId: opportunity.id,
      kind: target.kind,
      query: target.query,
      comparisonDates: previousDates.rows[0].dates,
      targetedComplete: !targeted.materialPrimaryTruncation,
      incompletePrimaryRoutes: targeted.incompletePrimaryRoutes,
      missingRequiredRoutes: targeted.missingRequiredRoutes,
    });
  }
  return output;
}

export function patchCandidateGate(input: {
  verdict: string;
  stale: boolean;
  allReferencesValid: boolean;
  sourceComplete: boolean;
  requiredEvidenceResolved: boolean;
  concreteTarget: boolean;
  destructiveAction?: boolean;
}) {
  return (
    input.verdict === 'PROPOSE_CHANGE' &&
    !input.stale &&
    input.allReferencesValid &&
    input.sourceComplete &&
    input.requiredEvidenceResolved &&
    input.concreteTarget &&
    !input.destructiveAction
  );
}
