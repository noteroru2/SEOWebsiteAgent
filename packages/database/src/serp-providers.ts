import type { Pool, PoolClient } from 'pg';
import {
  capabilityMismatch,
  classifyEvidenceRequirement,
  classifySerpIntent,
  materialSerpObservationConflict,
  serpEvidenceTrust,
  selectProvider,
  type NormalizedSerpResult,
  type ProviderName,
  type SerpDevice,
  type SerpEvidenceRequirement,
  type SerpProviderCapabilities,
  type SerpReviewPolicy,
  type SerpFailureDiagnostics,
  type VerifiedSerpLocationSnapshot,
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

export async function verifiedSerpLocationProfilesForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  return (
    await pool.query(
      `SELECT p.* FROM serp_location_profiles p JOIN opportunities o ON o.site_id=p.site_id
       WHERE o.id=$1 AND p.status='ACTIVE' ORDER BY p.owner_label,p.provider`,
      [opportunityId],
    )
  ).rows;
}

function locationSnapshot(profile: Record<string, unknown>): VerifiedSerpLocationSnapshot {
  return {
    locationProfileId: String(profile.id),
    requestedLocationLabel: String(profile.owner_label),
    provider: profile.provider as ProviderName,
    canonicalProviderLocation: String(profile.canonical_location),
    providerLocationId: String(profile.provider_location_id),
    verifiedPrecision: profile.precision as VerifiedSerpLocationSnapshot['verifiedPrecision'],
    countryCode: String(profile.country_code),
    timezone: String(profile.timezone),
    verifiedAt: new Date(String(profile.verified_at)).toISOString(),
    verificationSource: String(profile.verification_source),
  };
}

function assertVerifiedLocation(
  requirement: SerpEvidenceRequirement,
  snapshot: VerifiedSerpLocationSnapshot,
  status: unknown,
) {
  if (status !== 'ACTIVE') throw new Error('SERP_LOCATION_PROFILE_INACTIVE');
  if (snapshot.provider !== 'SERPAPI') throw new Error('SERP_LOCATION_PROVIDER_MISMATCH');
  if (!snapshot.canonicalProviderLocation.trim() || !snapshot.providerLocationId.trim())
    throw new Error('SERP_LOCATION_IDENTITY_UNVERIFIED');
  if (
    requirement.requiredPrecision === 'CITY' &&
    !['CITY', 'COORDINATE'].includes(snapshot.verifiedPrecision)
  )
    throw new Error('SERP_LOCATION_PRECISION_DOWNGRADE');
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
  return result.rows.map((row) => {
    const credentialConfigured = configured[row.provider as ProviderName];
    const effectiveHealth = !credentialConfigured
      ? 'NOT_CONFIGURED'
      : !row.period_id || Number(row.remaining) <= 0
        ? 'FREE_QUOTA_EXHAUSTED'
        : row.health;
    return {
      ...row,
      credential_configured: credentialConfigured,
      effective_health: effectiveHealth,
      selection_eligible:
        row.enabled &&
        credentialConfigured &&
        effectiveHealth === 'AVAILABLE' &&
        Number(row.remaining) > 0 &&
        (!row.cooldown_until || new Date(row.cooldown_until).getTime() <= Date.now()),
    };
  });
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
       last_error_category=NULL,consecutive_failures=0,cooldown_until=NULL,updated_at=now()
       WHERE provider=$1 RETURNING *`,
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

function requestFingerprint(
  requestId: string,
  requirement: SerpEvidenceRequirement,
  reviewPolicy: SerpReviewPolicy,
  location: VerifiedSerpLocationSnapshot,
) {
  return evidenceHash({ requestId, reviewPolicy, location, ...requirement });
}

export async function enqueueSerpApiCapture(
  input: {
    opportunityId: string;
    requestId: string;
    locationProfileId: string;
    device?: SerpDevice;
    maxOrganicResults?: 20 | 30;
    reviewPolicy?: SerpReviewPolicy;
  },
  configured = providerCredentialsConfigured(),
  pool: Pool = getDatabase().pool,
) {
  const selected = await pool.query(
    `SELECT r.type,o.site_id,o.query,o.evidence opportunity_evidence,s.url FROM evidence_requests r
     JOIN opportunities o ON o.id=r.opportunity_id JOIN sites s ON s.id=o.site_id
     WHERE r.id=$1 AND r.opportunity_id=$2`,
    [input.requestId, input.opportunityId],
  );
  const row = selected.rows[0];
  if (!row || row.type !== 'MANUAL_SERP_OBSERVATION')
    throw new Error('SERP evidence request required');
  const targetDomain = new URL(row.url).hostname.replace(/^www\./, '').toLowerCase();
  if (targetDomain !== 'amphon.co.th') throw new Error('SERP API target is not approved');
  const profile = (
    await pool.query(`SELECT * FROM serp_location_profiles WHERE id=$1 AND site_id=$2`, [
      input.locationProfileId,
      row.site_id,
    ])
  ).rows[0];
  if (!profile) throw new Error('Verified SERP location profile required');
  const location = locationSnapshot(profile);
  const requirement = classifyEvidenceRequirement({
    query: String(row.query),
    requestedLocation: location.canonicalProviderLocation,
    device: input.device,
    targetDomain,
    maxOrganicResults: input.maxOrganicResults,
    metadata: (row.opportunity_evidence ?? {}) as Record<string, unknown>,
  });
  assertVerifiedLocation(requirement, location, profile.status);
  const reviewPolicy = input.reviewPolicy ?? 'AUTO_ACCEPT_IF_POLICY_ALLOWS';
  const status = await serpProviderStatus(configured, pool);
  const provider = selectProvider(
    requirement,
    status
      .filter((item) => item.provider === location.provider)
      .map((item) => ({
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
  const fingerprint = requestFingerprint(input.requestId, requirement, reviewPolicy, location);
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
       query,requested_location,required_precision,device,target_domain,max_organic_results,review_policy,
       location_profile_id,requested_location_label,canonical_provider_location,provider_location_id,
       verified_precision,country_code,location_timezone,location_verified_at,location_verification_source,
       intent_class,trust_role)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
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
        reviewPolicy,
        location.locationProfileId,
        location.requestedLocationLabel,
        location.canonicalProviderLocation,
        location.providerLocationId,
        location.verifiedPrecision,
        location.countryCode,
        location.timezone,
        location.verifiedAt,
        location.verificationSource,
        requirement.intentClass,
        serpEvidenceTrust(
          requirement.intentClass ?? 'NORMAL',
          requirement.requiredPrecision === 'CITY' ? 'SERP_API_CITY' : 'SERP_API_COUNTRY',
        ),
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
          reviewPolicy,
          device: requirement.device,
          ...location,
          requiredPrecision: requirement.requiredPrecision,
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
  expected?: Partial<VerifiedSerpLocationSnapshot> & {
    reviewPolicy?: SerpReviewPolicy;
    requiredPrecision?: SerpEvidenceRequirement['requiredPrecision'];
    device?: SerpDevice;
  },
) {
  assertFreeOnlyMode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(820243)');
    const capture = (
      await client.query(
        `SELECT c.*,p.status location_profile_status,p.provider live_location_provider,
          p.canonical_location live_canonical_location,p.provider_location_id live_provider_location_id,
          p.precision live_verified_precision
         FROM serp_api_captures c LEFT JOIN serp_location_profiles p ON p.id=c.location_profile_id
         WHERE c.id=$1 FOR UPDATE OF c`,
        [captureId],
      )
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
      intentClass:
        (capture.intent_class as SerpEvidenceRequirement['intentClass']) ??
        classifySerpIntent({ query: String(capture.query) }),
    };
    const snapshot: VerifiedSerpLocationSnapshot = {
      locationProfileId: String(capture.location_profile_id ?? ''),
      requestedLocationLabel: String(capture.requested_location_label ?? ''),
      provider: capture.provider as ProviderName,
      canonicalProviderLocation: String(capture.canonical_provider_location ?? ''),
      providerLocationId: String(capture.provider_location_id ?? ''),
      verifiedPrecision: capture.verified_precision,
      countryCode: String(capture.country_code ?? ''),
      timezone: String(capture.location_timezone ?? ''),
      verifiedAt: new Date(capture.location_verified_at).toISOString(),
      verificationSource: String(capture.location_verification_source ?? ''),
    };
    assertVerifiedLocation(requirement, snapshot, capture.location_profile_status);
    if (expected?.device !== undefined && expected.device !== requirement.device)
      throw new Error('SERP_DEVICE_JOB_IDENTITY_MISMATCH');
    if (
      expected &&
      (expected.reviewPolicy !== capture.review_policy ||
        expected.locationProfileId !== snapshot.locationProfileId ||
        expected.provider !== snapshot.provider ||
        expected.canonicalProviderLocation !== snapshot.canonicalProviderLocation ||
        expected.providerLocationId !== snapshot.providerLocationId ||
        expected.verifiedPrecision !== snapshot.verifiedPrecision ||
        expected.countryCode !== snapshot.countryCode ||
        expected.timezone !== snapshot.timezone ||
        expected.requestedLocationLabel !== snapshot.requestedLocationLabel ||
        expected.verifiedAt !== snapshot.verifiedAt ||
        expected.verificationSource !== snapshot.verificationSource ||
        expected.requiredPrecision !== requirement.requiredPrecision)
    )
      throw new Error('SERP_LOCATION_JOB_IDENTITY_MISMATCH');
    if (
      capture.requested_location !== snapshot.canonicalProviderLocation ||
      capture.live_location_provider !== snapshot.provider ||
      capture.live_canonical_location !== snapshot.canonicalProviderLocation ||
      capture.live_provider_location_id !== snapshot.providerLocationId ||
      capture.live_verified_precision !== snapshot.verifiedPrecision
    )
      throw new Error('SERP_LOCATION_SNAPSHOT_MISMATCH');
    const rows = await client.query(
      `SELECT c.*,p.id period_id,p.configured_allowance-coalesce(p.used,0)-coalesce(p.reserved,0) remaining
       FROM serp_provider_configs c LEFT JOIN LATERAL (SELECT * FROM serp_provider_usage_periods p
       WHERE p.provider=c.provider AND p.period_start<=now() AND (p.period_end IS NULL OR p.period_end>now())
       ORDER BY p.period_start DESC LIMIT 1) p ON true ORDER BY c.priority FOR UPDATE OF c`,
    );
    const candidates = rows.rows
      .filter((item) => item.provider === snapshot.provider)
      .map((item) => ({
        provider: item.provider,
        enabled: item.enabled,
        configured: configured[item.provider as ProviderName],
        health: item.health,
        remaining: Number(item.remaining ?? 0),
        priority: item.priority,
        capabilities: item.capabilities,
      }));
    const provider = selectProvider(requirement, candidates);
    if (!provider) {
      const candidate = candidates[0];
      const mismatch = candidate ? capabilityMismatch(candidate.capabilities, requirement) : null;
      const failure = mismatch
        ? {
            status: 'CAPABILITY_MISMATCH',
            code: 'CAPABILITY_MISMATCH',
            summary: `Provider capability mismatch: ${mismatch}`,
            origin: 'REQUEST',
          }
        : candidate?.health === 'FREE_QUOTA_EXHAUSTED' || Number(candidate?.remaining ?? 0) <= 0
          ? {
              status: 'FREE_QUOTA_EXHAUSTED',
              code: 'FREE_QUOTA_EXHAUSTED',
              summary: 'No owner-authorized free provider allowance remains',
              origin: 'PROVIDER',
            }
          : candidate?.health === 'AUTH_FAILED'
            ? {
                status: 'AUTH_FAILED',
                code: 'AUTH_FAILED',
                summary: 'Provider authentication requires owner action',
                origin: 'PROVIDER',
              }
            : candidate?.health === 'RATE_LIMITED'
              ? {
                  status: 'RATE_LIMITED',
                  code: 'RATE_LIMITED',
                  summary: 'Provider is rate limited; owner action required',
                  origin: 'PROVIDER',
                }
              : {
                  status: 'FAILED',
                  code: candidate?.health ?? 'NO_PROVIDER_CONFIGURED',
                  summary: 'No eligible provider is available; owner action required',
                  origin: 'UNKNOWN',
                };
      await client.query(
        `UPDATE serp_api_captures SET status=$2,failure_code=$3,failure_summary=$4,
         failure_origin=$5,updated_at=now() WHERE id=$1`,
        [captureId, failure.status, failure.code, failure.summary, failure.origin],
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
    const ownerPositions = owner.flatMap((row: { evidence?: Record<string, unknown> }) => {
      const position = Number(row.evidence?.approximatePosition);
      return Number.isFinite(position) ? [position] : [];
    });
    const conflict = ownerPositions.some((position) =>
      materialSerpObservationConflict(position, result.targetOrganicPosition, result.targetFound),
    );
    const intentClass =
      capture.intent_class === 'HYPERLOCAL' ||
      classifySerpIntent({ query: String(capture.query) }) === 'HYPERLOCAL'
        ? 'HYPERLOCAL'
        : 'NORMAL';
    const trustRole = serpEvidenceTrust(
      intentClass,
      result.locationPrecision === 'CITY' ? 'SERP_API_CITY' : 'SERP_API_COUNTRY',
    );
    const evidence = {
      ...result,
      provenance: 'SERP_API_CAPTURED',
      evidenceQuality: result.locationPrecision === 'CITY' ? 'SERP_API_CITY' : 'SERP_API_COUNTRY',
      conflict: conflict ? 'SERP_OBSERVATION_CONFLICT' : null,
      intentClass,
      trustRole,
    };
    const autoAccepted =
      intentClass !== 'HYPERLOCAL' &&
      capture.review_policy !== 'OWNER_REVIEW_REQUIRED' &&
      autoAcceptOpportunityKinds.has(String(capture.opportunity_kind));
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
      expires_at=$13::timestamptz+($14::int*interval '1 hour'),intent_class=$16,trust_role=$17,
      conflict_detail=$18::jsonb,provider_http_status=$19,provider_search_status=$20,
      provider_latency_ms=$21,provider_response_content_type=$22,updated_at=now() WHERE id=$1`,
      [
        captureId,
        JSON.stringify(evidence),
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
        intentClass,
        trustRole,
        conflict
          ? JSON.stringify({
              type: 'SERP_OBSERVATION_CONFLICT',
              ownerPositions,
              providerTargetState: result.targetFound
                ? `POSITION_${result.targetOrganicPosition}`
                : `TARGET_NOT_FOUND_TOP_${capture.max_organic_results}`,
              policyVersion: 'hyperlocal-serp-trust-v1',
            })
          : null,
        result.providerHttpStatus ?? null,
        result.providerSearchStatus ?? null,
        result.providerLatencyMs ?? null,
        result.providerResponseContentType ?? null,
      ],
    );
    await client.query(
      `UPDATE serp_provider_configs SET health='AVAILABLE',last_success_at=now(),last_error_category=NULL,
       consecutive_failures=0,cooldown_until=NULL,updated_at=now() WHERE provider=$1`,
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
        `SELECT * FROM serp_api_captures WHERE id=$1 AND status IN ('PENDING_REVIEW','ACCEPTED') FOR UPDATE`,
        [captureId],
      )
    ).rows[0];
    if (capture?.status === 'ACCEPTED') {
      await client.query('COMMIT');
      return { ...capture, idempotent: true };
    }
    if (capture?.intent_class === 'HYPERLOCAL' || capture?.trust_role === 'SUPPORTING_ONLY')
      throw new Error('Hyperlocal SERP API captures are supporting evidence only');
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
    diagnostics?: SerpFailureDiagnostics;
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
            : input.category === 'CAPABILITY_MISMATCH'
              ? 'CAPABILITY_MISMATCH'
              : 'TEMPORARILY_UNAVAILABLE';
    const captureStatus =
      input.category === 'FREE_QUOTA_EXHAUSTED'
        ? 'FREE_QUOTA_EXHAUSTED'
        : input.category === 'AUTH_FAILED'
          ? 'AUTH_FAILED'
          : input.category === 'RATE_LIMITED'
            ? 'RATE_LIMITED'
            : input.category === 'CAPABILITY_MISMATCH'
              ? 'CAPABILITY_MISMATCH'
              : 'FAILED';
    const diagnostics = input.diagnostics ?? { origin: 'UNKNOWN' as const };
    const history = {
      provider: input.provider,
      category: input.category,
      origin: diagnostics.origin,
      httpStatus: diagnostics.httpStatus ?? null,
      providerCode: diagnostics.providerCode ?? null,
      responseContentType: diagnostics.responseContentType ?? null,
      providerRequestId: diagnostics.providerRequestId ?? null,
      providerStatus: diagnostics.providerStatus ?? null,
      latencyMs: diagnostics.latencyMs ?? null,
      occurredAt: new Date().toISOString(),
    };
    await client.query(
      `UPDATE serp_provider_configs SET health=$2,last_failure_at=now(),last_error_category=$3,
       consecutive_failures=consecutive_failures+1,
       cooldown_until=CASE WHEN $3 IN ('TEMPORARILY_UNAVAILABLE','NETWORK_TIMEOUT','PROVIDER_ERROR','UNKNOWN_FAILURE','MALFORMED_RESPONSE')
         THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now() WHERE provider=$1`,
      [input.provider, health, input.category],
    );
    await client.query(
      `UPDATE serp_api_captures SET status=$2,failure_code=$3,failure_summary=$4,
       failure_origin=$5,failure_http_status=$6,failure_provider_code=$7,
       failure_content_type=$8,failure_provider_status=$9,
       provider_request_id=coalesce(provider_request_id,$10),
       failure_history=failure_history || $11::jsonb,failure_latency_ms=$12,
       updated_at=now() WHERE id=$1`,
      [
        input.captureId,
        captureStatus,
        input.category,
        input.summary.slice(0, 300),
        diagnostics.origin,
        diagnostics.httpStatus ?? null,
        diagnostics.providerCode?.slice(0, 120) ?? null,
        diagnostics.responseContentType?.slice(0, 120) ?? null,
        diagnostics.providerStatus?.slice(0, 120) ?? null,
        diagnostics.providerRequestId?.slice(0, 120) ?? null,
        JSON.stringify([history]),
        diagnostics.latencyMs ?? null,
      ],
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

export async function rejectSerpApiCaptureForContext(
  captureId: string,
  reason = 'HYPERLOCAL_CONTEXT_DISAGREEMENT',
  pool: Pool = getDatabase().pool,
) {
  if (!/^[A-Z0-9_]{3,80}$/.test(reason)) throw new Error('Safe context rejection reason required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `UPDATE serp_api_captures SET status='REJECTED_FOR_TARGET_CONTEXT',failure_code=$2,
       failure_summary='Provider-context observation retained as supporting evidence only',
       rejection_reason=$2,intent_class='HYPERLOCAL',trust_role='SUPPORTING_ONLY',updated_at=now()
       WHERE id=$1 AND status='PENDING_REVIEW' AND normalized_result IS NOT NULL RETURNING *`,
      [captureId, reason],
    );
    if (!row.rows[0]) throw new Error('Pending hyperlocal API capture required');
    await client.query(
      `INSERT INTO system_events(source,level,event,detail)
       VALUES('serp-trust-policy','INFO','SERP_CAPTURE_CONTEXT_REJECTED',
       jsonb_build_object('captureId',$1::text,'reason',$2::text))`,
      [captureId, reason],
    );
    await client.query('COMMIT');
    return row.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function invalidateSerpApiCapture(
  captureId: string,
  reason: string,
  pool: Pool = getDatabase().pool,
) {
  if (!/^[A-Z0-9_]{3,80}$/.test(reason)) throw new Error('Safe invalidation reason required');
  const row = await pool.query(
    `UPDATE serp_api_captures c SET
       status='REJECTED',failure_code=$2::text,
       failure_summary='Capture retained for audit and excluded from evidence',
       normalized_result=coalesce(c.normalized_result,'{}'::jsonb) || jsonb_build_object(
         'intendedQuery',o.query,
         'actualTransmittedQuery',coalesce(c.normalized_result->>'query',c.query),
         'invalidationReason',$2::text,
         'invalidatedAt',now()
       ),updated_at=now()
     FROM opportunities o
     WHERE c.id=$1 AND c.opportunity_id=o.id AND c.status='PENDING_REVIEW'
     RETURNING c.*`,
    [captureId, reason],
  );
  if (!row.rows[0]) throw new Error('Pending review SERP API capture required');
  return row.rows[0];
}
