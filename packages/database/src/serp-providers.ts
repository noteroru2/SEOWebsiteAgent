import type { Pool, PoolClient } from 'pg';
import {
  classifyEvidenceRequirement,
  selectProvider,
  type NormalizedSerpResult,
  type ProviderName,
  type SerpDevice,
  type SerpEvidenceRequirement,
  type SerpProviderCapabilities,
} from '@seo-agent/serp-providers';
import { evidenceHash, recordEvidenceItem } from './evidence-resolution';
import { getDatabase } from './index';

export const SERP_BILLING_MODE = 'FREE_ONLY' as const;
export const DEFAULT_SERP_FRESHNESS_HOURS = 24;
const autoAcceptOpportunityKinds = new Set([
  'LOW_CTR_QUERY',
  'STRIKING_DISTANCE_QUERY',
  'DECLINING_QUERY',
]);

export function assertFreeOnlyMode(env?: { SERP_BILLING_MODE?: string }) {
  const mode = env?.SERP_BILLING_MODE || process.env.SERP_BILLING_MODE || SERP_BILLING_MODE;
  if (mode !== SERP_BILLING_MODE) throw new Error('Only SERP_BILLING_MODE=FREE_ONLY is supported');
  return mode;
}

export function providerCredentialsConfigured(env: NodeJS.ProcessEnv = process.env) {
  return {
    SERPAPI: Boolean(env.SERPAPI_API_KEY),
    SERPSTACK: Boolean(env.SERPSTACK_API_KEY),
    SERPER: Boolean(env.SERPER_API_KEY),
  } satisfies Record<ProviderName, boolean>;
}

export async function serpProviderStatus(
  configured = providerCredentialsConfigured(),
  pool: Pool = getDatabase().pool,
) {
  const result = await pool.query(
    `SELECT c.*,p.id period_id,p.period_start,p.period_end,p.configured_allowance period_allowance,
     coalesce(p.used,0)::int used,coalesce(p.reserved,0)::int reserved,
     greatest(coalesce(p.configured_allowance,0)-coalesce(p.used,0)-coalesce(p.reserved,0),0)::int remaining
     FROM serp_provider_configs c LEFT JOIN LATERAL (
       SELECT * FROM serp_provider_usage_periods p WHERE p.provider=c.provider
       AND p.period_start<=now() AND (p.period_end IS NULL OR p.period_end>now())
       ORDER BY p.period_start DESC LIMIT 1
     ) p ON true ORDER BY c.priority`,
  );
  return result.rows.map((row) => ({
    ...row,
    credential_configured: configured[row.provider as ProviderName],
    effective_health: !configured[row.provider as ProviderName]
      ? 'NOT_CONFIGURED'
      : !row.period_id || Number(row.remaining) <= 0
        ? 'FREE_QUOTA_EXHAUSTED'
        : row.health,
  }));
}

export async function configureSerpProvider(
  input: {
    provider: ProviderName;
    enabled: boolean;
    configuredAllowance: number;
    periodStart: Date;
    periodEnd: Date | null;
  },
  pool: Pool = getDatabase().pool,
) {
  if (!Number.isInteger(input.configuredAllowance) || input.configuredAllowance < 0)
    throw new Error('Configured allowance must be a non-negative integer');
  if (input.periodEnd && input.periodEnd <= input.periodStart)
    throw new Error('Period end must follow period start');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const config = await client.query(
      `UPDATE serp_provider_configs SET enabled=$2,configured_allowance=$3,health='AVAILABLE',
       last_error_category=NULL,updated_at=now() WHERE provider=$1 RETURNING *`,
      [input.provider, input.enabled, input.configuredAllowance],
    );
    if (!config.rows[0]) throw new Error('Unknown SERP provider');
    await client.query(
      `UPDATE serp_provider_usage_periods SET period_end=$2,updated_at=now()
       WHERE provider=$1 AND period_end IS NULL AND period_start<>$3`,
      [input.provider, input.periodStart, input.periodStart],
    );
    await client.query(
      `INSERT INTO serp_provider_usage_periods(provider,period_start,period_end,configured_allowance)
       VALUES($1,$2,$3,$4) ON CONFLICT(provider,period_start) DO UPDATE SET
       period_end=excluded.period_end,configured_allowance=GREATEST(excluded.configured_allowance,
       serp_provider_usage_periods.used+serp_provider_usage_periods.reserved),updated_at=now()`,
      [input.provider, input.periodStart, input.periodEnd, input.configuredAllowance],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requestFingerprint(requestId: string, requirement: SerpEvidenceRequirement) {
  return evidenceHash({ requestId, ...requirement });
}

export async function enqueueSerpApiCapture(
  input: {
    opportunityId: string;
    requestId: string;
    requestedLocation: string;
    device?: SerpDevice;
    maxOrganicResults?: 20 | 30;
  },
  configured = providerCredentialsConfigured(),
  pool: Pool = getDatabase().pool,
) {
  const selected = await pool.query(
    `SELECT r.type,o.site_id,o.query,s.url FROM evidence_requests r
     JOIN opportunities o ON o.id=r.opportunity_id JOIN sites s ON s.id=o.site_id
     WHERE r.id=$1 AND r.opportunity_id=$2`,
    [input.requestId, input.opportunityId],
  );
  const row = selected.rows[0];
  if (!row || row.type !== 'MANUAL_SERP_OBSERVATION')
    throw new Error('SERP evidence request required');
  const targetDomain = new URL(row.url).hostname.replace(/^www\./, '').toLowerCase();
  if (targetDomain !== 'amphon.co.th') throw new Error('SERP API target is not approved');
  const requirement = classifyEvidenceRequirement({
    query: String(row.query),
    requestedLocation: input.requestedLocation,
    device: input.device,
    targetDomain,
    maxOrganicResults: input.maxOrganicResults,
  });
  const status = await serpProviderStatus(configured, pool);
  const provider = selectProvider(
    requirement,
    status.map((item) => ({
      provider: item.provider,
      enabled: item.enabled,
      configured: item.credential_configured,
      health: item.effective_health,
      remaining: item.remaining,
      priority: item.priority,
      capabilities: item.capabilities as SerpProviderCapabilities,
    })),
  );
  if (!provider) return { queued: false as const, fallback: 'OWNER_BROWSER' as const, requirement };
  const fingerprint = requestFingerprint(input.requestId, requirement);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = await client.query(
      `SELECT * FROM serp_api_captures WHERE request_fingerprint=$1
       AND status IN ('QUEUED','FETCHING') LIMIT 1`,
      [fingerprint],
    );
    if (active.rows[0]) {
      await client.query('COMMIT');
      return { queued: true as const, capture: active.rows[0], deduplicated: true, requirement };
    }
    const capture = await client.query(
      `INSERT INTO serp_api_captures(site_id,opportunity_id,request_id,provider,request_fingerprint,
       query,requested_location,required_precision,device,target_domain,max_organic_results)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        row.site_id,
        input.opportunityId,
        input.requestId,
        provider,
        fingerprint,
        requirement.query,
        requirement.requestedLocation,
        requirement.requiredPrecision,
        requirement.device,
        requirement.targetDomain,
        requirement.maxOrganicResults,
      ],
    );
    const job = await client.query(
      `INSERT INTO jobs(site_id,type,status,heavy,payload) VALUES($1,'FETCH_SERP_API','QUEUED',true,$2::jsonb) RETURNING *`,
      [
        row.site_id,
        JSON.stringify({
          captureId: capture.rows[0].id,
          requestId: input.requestId,
          opportunityId: input.opportunityId,
        }),
      ],
    );
    await client.query(`UPDATE serp_api_captures SET job_id=$2 WHERE id=$1`, [
      capture.rows[0].id,
      job.rows[0].id,
    ]);
    await client.query(`INSERT INTO job_events(job_id,event) VALUES($1,'ENQUEUED')`, [
      job.rows[0].id,
    ]);
    await client.query('COMMIT');
    return {
      queued: true as const,
      capture: { ...capture.rows[0], job_id: job.rows[0].id },
      deduplicated: false,
      requirement,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveSerpProviderAttempt(
  captureId: string,
  configured = providerCredentialsConfigured(),
  pool: Pool = getDatabase().pool,
) {
  assertFreeOnlyMode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(820243)');
    const capture = (
      await client.query(`SELECT * FROM serp_api_captures WHERE id=$1 FOR UPDATE`, [captureId])
    ).rows[0];
    if (!capture || !['QUEUED', 'FETCHING'].includes(capture.status))
      throw new Error('Active SERP API capture required');
    const requirement: SerpEvidenceRequirement = {
      query: capture.query,
      requestedLocation: capture.requested_location,
      requiredPrecision: capture.required_precision,
      device: capture.device,
      targetDomain: capture.target_domain,
      maxOrganicResults: capture.max_organic_results,
    };
    const rows = await client.query(
      `SELECT c.*,p.id period_id,p.configured_allowance-coalesce(p.used,0)-coalesce(p.reserved,0) remaining
       FROM serp_provider_configs c LEFT JOIN LATERAL (SELECT * FROM serp_provider_usage_periods p
       WHERE p.provider=c.provider AND p.period_start<=now() AND (p.period_end IS NULL OR p.period_end>now())
       ORDER BY p.period_start DESC LIMIT 1) p ON true ORDER BY c.priority FOR UPDATE OF c`,
    );
    const provider = selectProvider(
      requirement,
      rows.rows.map((item) => ({
        provider: item.provider,
        enabled: item.enabled,
        configured: configured[item.provider as ProviderName],
        health: item.health,
        remaining: Number(item.remaining ?? 0),
        priority: item.priority,
        capabilities: item.capabilities,
      })),
    );
    if (!provider) {
      await client.query(
        `UPDATE serp_api_captures SET status='CAPABILITY_MISMATCH',failure_code='NO_FREE_PROVIDER',failure_summary='Use owner browser capture',updated_at=now() WHERE id=$1`,
        [captureId],
      );
      await client.query('COMMIT');
      return null;
    }
    const period = rows.rows.find((item) => item.provider === provider);
    const reserved = await client.query(
      `UPDATE serp_provider_usage_periods SET reserved=reserved+1,updated_at=now()
       WHERE id=$1 AND used+reserved<configured_allowance RETURNING *`,
      [period.period_id],
    );
    if (!reserved.rows[0]) throw new Error('No free allowance remains');
    const reservation = await client.query(
      `INSERT INTO serp_provider_reservations(provider,usage_period_id,capture_id)
       VALUES($1,$2,$3) ON CONFLICT(capture_id,provider) DO NOTHING RETURNING *`,
      [provider, period.period_id, captureId],
    );
    if (!reservation.rows[0]) throw new Error('Provider attempt already reserved');
    await client.query(
      `UPDATE serp_api_captures SET provider=$2,status='FETCHING',updated_at=now() WHERE id=$1`,
      [captureId, provider],
    );
    await client.query('COMMIT');
    return {
      capture: { ...capture, provider, status: 'FETCHING' },
      requirement,
      provider,
      reservation: reservation.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function settleReservation(
  captureId: string,
  provider: ProviderName,
  consume: boolean,
  client: PoolClient,
) {
  const reservation = (
    await client.query(
      `SELECT * FROM serp_provider_reservations WHERE capture_id=$1 AND provider=$2 AND status='RESERVED' FOR UPDATE`,
      [captureId, provider],
    )
  ).rows[0];
  if (!reservation) throw new Error('Active free allowance reservation required');
  await client.query(
    `UPDATE serp_provider_usage_periods SET reserved=reserved-1,used=used+$2,updated_at=now() WHERE id=$1`,
    [reservation.usage_period_id, consume ? 1 : 0],
  );
  await client.query(
    `UPDATE serp_provider_reservations SET status=$2,settled_at=now() WHERE id=$1`,
    [reservation.id, consume ? 'CONSUMED' : 'RELEASED'],
  );
}

async function staleV3(opportunityId: string, client: PoolClient) {
  await client.query(
    `UPDATE source_change_plans p SET status='STALE',stale_at=now(),updated_at=now()
    FROM source_plan_runs r WHERE p.run_id=r.id AND r.opportunity_id=$1
    AND r.prompt_version='source-change-plan-prompt-v3' AND p.status IN ('READY_FOR_REVIEW','APPROVED')`,
    [opportunityId],
  );
}

export async function persistSerpApiSuccess(
  captureId: string,
  result: NormalizedSerpResult,
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const capture = (
      await client.query(
        `SELECT c.*,o.kind opportunity_kind FROM serp_api_captures c
         JOIN opportunities o ON o.id=c.opportunity_id
         WHERE c.id=$1 AND c.status='FETCHING' FOR UPDATE OF c`,
        [captureId],
      )
    ).rows[0];
    if (!capture || capture.provider !== result.provider)
      throw new Error('Matching fetching capture required');
    await settleReservation(captureId, result.provider, true, client);
    const owner = (
      await client.query(
        `SELECT evidence FROM evidence_items WHERE request_id=$1 AND source_type IN ('OWNER_CONFIRMED_BROWSER_CAPTURE','OWNER_OBSERVED_SERP') ORDER BY created_at DESC`,
        [capture.request_id],
      )
    ).rows;
    const conflict = owner.some((row: { evidence?: Record<string, unknown> }) => {
      const position = Number(row.evidence?.approximatePosition);
      return (
        Number.isFinite(position) &&
        result.targetOrganicPosition !== null &&
        position !== result.targetOrganicPosition
      );
    });
    const evidence = {
      ...result,
      provenance: 'SERP_API_CAPTURED',
      evidenceQuality: result.locationPrecision === 'CITY' ? 'SERP_API_CITY' : 'SERP_API_COUNTRY',
      conflict: conflict ? 'SERP_OBSERVATION_CONFLICT' : null,
    };
    const autoAccepted = autoAcceptOpportunityKinds.has(String(capture.opportunity_kind));
    if (autoAccepted) {
      await recordEvidenceItem(
        String(capture.request_id),
        'SERP_API_CAPTURED',
        evidence,
        new Date(result.capturedAt),
        client as unknown as Pool,
        'UTC',
      );
      await client.query(
        `UPDATE evidence_requests SET status='RESOLVED',updated_at=now() WHERE id=$1`,
        [capture.request_id],
      );
    }
    await client.query(
      `UPDATE serp_api_captures SET status=$15,normalized_result=$2::jsonb,
      provider_request_id=$3,provider_location_used=$4,location_precision=$5,target_found=$6,
      target_organic_position=$7,target_url=$8,target_title=$9,target_snippet=$10,evidence_quality=$11,
      conflict=$12,captured_at=$13::timestamptz,
      expires_at=$13::timestamptz+($14::int*interval '1 hour'),updated_at=now() WHERE id=$1`,
      [
        captureId,
        JSON.stringify(result),
        result.providerRequestId,
        result.providerLocationUsed,
        result.locationPrecision,
        result.targetFound,
        result.targetOrganicPosition,
        result.targetUrl,
        result.targetTitle,
        result.targetSnippet,
        evidence.evidenceQuality,
        conflict,
        result.capturedAt,
        DEFAULT_SERP_FRESHNESS_HOURS,
        autoAccepted ? 'ACCEPTED' : 'PENDING_REVIEW',
      ],
    );
    await client.query(
      `UPDATE serp_provider_configs SET health='AVAILABLE',last_success_at=now(),last_error_category=NULL,updated_at=now() WHERE provider=$1`,
      [result.provider],
    );
    if (autoAccepted) await staleV3(capture.opportunity_id, client);
    await client.query('COMMIT');
    return { accepted: autoAccepted, pendingReview: !autoAccepted, conflict };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptSerpApiCapture(captureId: string, pool: Pool = getDatabase().pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const capture = (
      await client.query(
        `SELECT * FROM serp_api_captures WHERE id=$1 AND status='PENDING_REVIEW' FOR UPDATE`,
        [captureId],
      )
    ).rows[0];
    if (!capture?.normalized_result) throw new Error('Reviewable SERP API capture required');
    const result = capture.normalized_result as NormalizedSerpResult;
    await recordEvidenceItem(
      String(capture.request_id),
      'OWNER_CONFIRMED_SERP_API_CAPTURE',
      {
        ...result,
        provenance: 'OWNER_CONFIRMED_SERP_API_CAPTURE',
        evidenceQuality: result.locationPrecision === 'CITY' ? 'SERP_API_CITY' : 'SERP_API_COUNTRY',
        conflict: capture.conflict ? 'SERP_OBSERVATION_CONFLICT' : null,
        ownerConfirmedAt: new Date().toISOString(),
      },
      new Date(result.capturedAt),
      client as unknown as Pool,
      'UTC',
    );
    await client.query(
      `UPDATE evidence_requests SET status='RESOLVED',updated_at=now() WHERE id=$1`,
      [capture.request_id],
    );
    await client.query(
      `UPDATE serp_api_captures SET status='ACCEPTED',updated_at=now() WHERE id=$1`,
      [captureId],
    );
    await staleV3(capture.opportunity_id, client);
    await client.query('COMMIT');
    return capture;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistSerpApiFailure(
  input: {
    captureId: string;
    provider: ProviderName;
    category: string;
    summary: string;
    provenNonCounted?: boolean;
  },
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await settleReservation(input.captureId, input.provider, !input.provenNonCounted, client);
    const health =
      input.category === 'FREE_QUOTA_EXHAUSTED'
        ? 'FREE_QUOTA_EXHAUSTED'
        : input.category === 'AUTH_FAILED'
          ? 'AUTH_FAILED'
          : input.category === 'RATE_LIMITED'
            ? 'RATE_LIMITED'
            : 'TEMPORARILY_UNAVAILABLE';
    await client.query(
      `UPDATE serp_provider_configs SET health=$2,last_failure_at=now(),last_error_category=$3,updated_at=now() WHERE provider=$1`,
      [input.provider, health, input.category],
    );
    await client.query(
      `UPDATE serp_api_captures SET status='QUEUED',failure_code=$2,failure_summary=$3,updated_at=now() WHERE id=$1`,
      [input.captureId, input.category, input.summary.slice(0, 300)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectSerpApiCapture(captureId: string, pool: Pool = getDatabase().pool) {
  const row = await pool.query(
    `UPDATE serp_api_captures SET status='REJECTED',updated_at=now() WHERE id=$1 AND status IN ('SUCCEEDED','PENDING_REVIEW') RETURNING *`,
    [captureId],
  );
  if (!row.rows[0]) throw new Error('Reviewable API capture required');
  return row.rows[0];
}
