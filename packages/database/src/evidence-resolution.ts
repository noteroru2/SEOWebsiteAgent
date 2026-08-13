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

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseLocalDateTime(value: string): LocalDateTime {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('Local observation date and time required without an offset');
  const result = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
  };
  const check = new Date(
    Date.UTC(result.year, result.month - 1, result.day, result.hour, result.minute, result.second),
  );
  if (
    check.getUTCFullYear() !== result.year ||
    check.getUTCMonth() + 1 !== result.month ||
    check.getUTCDate() !== result.day ||
    result.hour > 23 ||
    result.minute > 59 ||
    result.second > 59
  )
    throw new Error('Valid local observation date and time required');
  return result;
}

function zonedParts(formatter: Intl.DateTimeFormat, instant: number): LocalDateTime {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function sameLocal(a: LocalDateTime, b: LocalDateTime) {
  return Object.keys(a).every(
    (key) => a[key as keyof LocalDateTime] === b[key as keyof LocalDateTime],
  );
}

export function localDateTimeInTimeZoneToUtc(localDateTime: string, timeZone: string) {
  if (!timeZone?.trim()) throw new Error('Explicit observation timezone required');
  const local = parseLocalDateTime(localDateTime);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error('Valid IANA observation timezone required');
  }
  if (formatter.resolvedOptions().timeZone !== timeZone)
    throw new Error('Canonical IANA observation timezone required');
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const offsets = new Set<number>();
  for (let delta = -36 * 60; delta <= 36 * 60; delta += 30) {
    const sample = localAsUtc + delta * 60_000;
    const represented = zonedParts(formatter, sample);
    offsets.add(
      Date.UTC(
        represented.year,
        represented.month - 1,
        represented.day,
        represented.hour,
        represented.minute,
        represented.second,
      ) -
        Math.trunc(sample / 1000) * 1000,
    );
  }
  const matches = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((instant) => sameLocal(zonedParts(formatter, instant), local));
  if (matches.length !== 1)
    throw new Error(
      matches.length ? 'Ambiguous local observation time' : 'Nonexistent local observation time',
    );
  return new Date(matches[0]!);
}

function evidenceItemIdentity(evidence: unknown, observedAt?: Date, observedTimezone?: string) {
  return evidenceHash({
    evidence,
    observedAt: observedAt?.toISOString() ?? null,
    observedTimezone: observedTimezone ?? null,
  });
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
  observedTimezone?: string,
) {
  const item = await recordEvidenceItem(
    requestId,
    sourceType,
    evidence,
    observedAt,
    pool,
    observedTimezone,
  );
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
  observedTimezone?: string,
) {
  if (observedAt && !observedTimezone)
    throw new Error('Observation timezone required when observation time is supplied');
  const hash = evidenceItemIdentity(evidence, observedAt, observedTimezone);
  const item = await pool.query(
    `INSERT INTO evidence_items(request_id,source_type,evidence,evidence_hash,observed_at,observed_timezone)
     VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(request_id,evidence_hash) DO NOTHING
     RETURNING *`,
    [
      requestId,
      sourceType,
      JSON.stringify(evidence),
      hash,
      observedAt ?? null,
      observedTimezone ?? null,
    ],
  );
  if (item.rows[0]) return item.rows[0];
  return (
    await pool.query(
      `SELECT * FROM evidence_items WHERE request_id=$1 AND evidence_hash=$2 LIMIT 1`,
      [requestId, hash],
    )
  ).rows[0];
}

export async function storeOwnerEvidence(
  input: {
    requestId: string;
    sourceType: 'OWNER_OBSERVED_SERP' | 'OWNER_CONFIRMED';
    evidence: unknown;
    observedAt?: Date;
    observedTimezone?: string;
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
    input.observedTimezone,
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
      'evidenceHash',i.evidence_hash,'observedAt',i.observed_at,'observedTimezone',i.observed_timezone,'createdAt',i.created_at)
      ORDER BY i.created_at,i.id) FILTER(WHERE i.id IS NOT NULL),'[]') items
     FROM evidence_requests r LEFT JOIN evidence_items i ON i.request_id=r.id
     WHERE r.opportunity_id=$1 AND r.status<>'SUPERSEDED' GROUP BY r.id ORDER BY r.created_at`,
    [opportunityId],
  );
  return { requests: result.rows, completeness: evidenceCompleteness(result.rows) };
}

export async function evidenceReevaluationStateForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const [jobsResult, v3Result, workerResult] = await Promise.all([
    pool.query(
      `SELECT id,status,payload,result,failure_code,failure_summary,created_at,started_at,
        finished_at,heartbeat_at
       FROM jobs WHERE type='GENERATE_SOURCE_CHANGE_PLAN'
         AND payload->>'opportunityId'=$1 AND payload->>'evidenceReevaluation'='true'
       ORDER BY created_at DESC LIMIT 1`,
      [opportunityId],
    ),
    pool.query(
      `SELECT r.id run_id,r.job_id,r.status run_status,r.prompt_version,r.source_evidence_hash,
        r.failure_code,r.failure_summary,r.created_at,r.finished_at,p.id plan_id,p.status plan_status,
        p.verdict,p.confidence,j.payload->>'evidencePacketHash' evidence_packet_hash
       FROM source_plan_runs r LEFT JOIN source_change_plans p ON p.run_id=r.id
       LEFT JOIN jobs j ON j.id=r.job_id
       WHERE r.opportunity_id=$1 AND r.prompt_version='source-change-plan-prompt-v3'
       ORDER BY r.created_at DESC LIMIT 1`,
      [opportunityId],
    ),
    pool.query(
      `SELECT created_at FROM system_events WHERE source='worker' ORDER BY created_at DESC LIMIT 1`,
    ),
  ]);
  const latestJob = jobsResult.rows[0] ?? null;
  const lastHeartbeat = workerResult.rows[0]?.created_at ?? null;
  return {
    latestJob,
    activeJob:
      latestJob && ['QUEUED', 'RUNNING'].includes(String(latestJob.status)) ? latestJob : null,
    latestV3: v3Result.rows[0] ?? null,
    workerHealthy: Boolean(
      lastHeartbeat && Date.now() - new Date(lastHeartbeat).getTime() < 60_000,
    ),
    lastHeartbeat,
  };
}

export function currentEvidenceV3(
  latestV3: Record<string, unknown> | null,
  currentEvidencePacketHash: string,
) {
  if (
    !latestV3 ||
    !['SUCCEEDED', 'REUSED'].includes(String(latestV3.run_status)) ||
    latestV3.plan_status === 'STALE' ||
    latestV3.evidence_packet_hash !== currentEvidencePacketHash
  )
    return null;
  return latestV3;
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
    manualSerpObservation: byType('MANUAL_SERP_OBSERVATION').map((item) => ({
      ...item.evidence,
      observedAt: item.observedAt ? new Date(item.observedAt).toISOString() : null,
      observedTimezone: item.observedTimezone ?? null,
    })),
    ownerBusinessConfirmation: byType('OWNER_BUSINESS_CONFIRMATION').map((item) => item.evidence),
    ownerQueryOwnership: byType('OWNER_QUERY_OWNERSHIP').map((item) => item.evidence),
    unresolvedEvidence: panel.requests
      .filter((request) => request.status === 'OPEN')
      .map((request) => ({ type: request.type, requirement: request.requirement })),
  };
  return { packet, evidencePacketHash: evidenceHash(packet), completeness: panel.completeness };
}

export async function correctOwnerEvidenceTimestamp(
  input: {
    itemId: string;
    expectedObservedAt: string;
    localDateTime: string;
    timeZone: string;
  },
  pool: Pool = getDatabase().pool,
) {
  const corrected = localDateTimeInTimeZoneToUtc(input.localDateTime, input.timeZone);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT i.*,r.opportunity_id,r.type request_type
       FROM evidence_items i JOIN evidence_requests r ON r.id=i.request_id
       WHERE i.id=$1 FOR UPDATE OF i,r`,
      [input.itemId],
    );
    const item = selected.rows[0];
    if (
      !item ||
      item.source_type !== 'OWNER_OBSERVED_SERP' ||
      item.request_type !== 'MANUAL_SERP_OBSERVATION'
    )
      throw new Error('Manual owner-observed SERP evidence item required');
    const originalObservedAt = item.observed_at ? new Date(item.observed_at).toISOString() : null;
    if (originalObservedAt !== new Date(input.expectedObservedAt).toISOString())
      throw new Error('Original observation timestamp does not match correction provenance');
    const oldPacket = await deterministicEvidencePacket(
      String(item.opportunity_id),
      client as unknown as Pool,
    );
    const correctedHash = evidenceItemIdentity(item.evidence, corrected, input.timeZone);
    await client.query(
      `UPDATE evidence_items SET observed_at=$2,observed_timezone=$3,evidence_hash=$4 WHERE id=$1`,
      [input.itemId, corrected, input.timeZone, correctedHash],
    );
    const newPacket = await deterministicEvidencePacket(
      String(item.opportunity_id),
      client as unknown as Pool,
    );
    const stale = await client.query(
      `UPDATE source_change_plans p SET status='STALE',stale_at=now(),updated_at=now()
       FROM source_plan_runs r WHERE p.run_id=r.id AND r.opportunity_id=$1
         AND r.prompt_version='source-change-plan-prompt-v3'
         AND p.status IN ('READY_FOR_REVIEW','APPROVED') RETURNING p.id`,
      [item.opportunity_id],
    );
    const detail = {
      opportunityId: item.opportunity_id,
      evidenceItemId: item.id,
      originalObservedAt,
      originalObservedTimezone: item.observed_timezone,
      originalEvidenceHash: item.evidence_hash,
      correctedObservedAt: corrected.toISOString(),
      correctedObservedTimezone: input.timeZone,
      correctedEvidenceHash: correctedHash,
      oldEvidencePacketHash: oldPacket.evidencePacketHash,
      newEvidencePacketHash: newPacket.evidencePacketHash,
      stalePlanIds: stale.rows.map((row) => row.id),
    };
    await client.query(
      `INSERT INTO system_events(source,level,event,detail)
       VALUES('owner-evidence','INFO','OWNER_EVIDENCE_TIMESTAMP_CORRECTED',$1::jsonb)`,
      [JSON.stringify(detail)],
    );
    await client.query('COMMIT');
    return detail;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
          ? `SERP observation evidence for “${target.query}”: location, device, displayed title/snippet, ranking URL, approximate position and features. May be satisfied by qualified SERP API evidence, owner browser capture, or manual owner observation.`
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
