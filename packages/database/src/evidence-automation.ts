import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import type { AssistedCapturePayload } from '@seo-agent/serp-capture';
import { ASSISTED_CAPTURE_VERSION, resolveGoogleHref } from '@seo-agent/serp-capture';
import { evidenceHash, recordEvidenceItem } from './evidence-resolution';
import { getDatabase } from './index';

export const ownerFactScopeTypes = [
  'BUSINESS_WIDE',
  'SERVICE',
  'PRODUCT_CATEGORY',
  'GEOGRAPHY',
  'SERVICE_GEOGRAPHY',
  'QUERY',
] as const;

export const BROWSER_CAPTURE_TOKEN_TTL_MS = 10 * 60 * 1_000;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function normalizedHost(value: string) {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

export function classifyRealBrowserDevice(userAgent: string) {
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(userAgent)) return 'REAL_MOBILE_BROWSER' as const;
  if (/Chrome|Chromium|Firefox|Safari|Edg\//i.test(userAgent))
    return 'REAL_DESKTOP_BROWSER' as const;
  return 'UNKNOWN_REAL_BROWSER' as const;
}

export async function createBrowserCaptureToken(
  input: {
    opportunityId: string;
    requestId: string;
    ownerDeclaredLocation: string;
  },
  pool: Pool = getDatabase().pool,
) {
  const location = input.ownerDeclaredLocation.trim();
  if (!location || location.length > 200) throw new Error('Owner-declared location is required');
  const selected = await pool.query(
    `SELECT r.type,o.site_id,o.query,s.url FROM evidence_requests r
     JOIN opportunities o ON o.id=r.opportunity_id JOIN sites s ON s.id=o.site_id
     WHERE r.id=$1 AND r.opportunity_id=$2`,
    [input.requestId, input.opportunityId],
  );
  const row = selected.rows[0];
  if (!row || row.type !== 'MANUAL_SERP_OBSERVATION')
    throw new Error('SERP evidence request required');
  if (!row.query) throw new Error('Opportunity query required');
  const targetDomain = normalizedHost(row.url);
  if (targetDomain !== 'amphon.co.th') throw new Error('Assisted capture target is not approved');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + BROWSER_CAPTURE_TOKEN_TTL_MS);
  await pool.query(
    `INSERT INTO browser_capture_tokens(site_id,opportunity_id,request_id,token_hash,expected_query,
     target_domain,owner_declared_location,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.site_id,
      input.opportunityId,
      input.requestId,
      tokenHash(token),
      row.query,
      targetDomain,
      location,
      expiresAt,
    ],
  );
  return {
    token,
    expiresAt,
    expectedQuery: String(row.query),
    targetDomain,
    opportunityId: input.opportunityId,
  };
}

export async function ingestOwnerAssistedCapture(
  payload: AssistedCapturePayload,
  pool: Pool = getDatabase().pool,
) {
  const capturedAt = new Date(payload.capturedAt);
  if (Math.abs(Date.now() - capturedAt.getTime()) > 30 * 60 * 1_000)
    throw new Error('Capture timestamp is outside the accepted window');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM browser_capture_tokens WHERE token_hash=$1 FOR UPDATE`,
      [tokenHash(payload.token)],
    );
    const grant = selected.rows[0];
    if (!grant || grant.consumed_at || new Date(grant.expires_at).getTime() <= Date.now())
      throw new Error('Capture token is invalid, expired, or already used');
    if (payload.opportunityId !== grant.opportunity_id)
      throw new Error('Capture opportunity does not match token');
    if (payload.query !== grant.expected_query)
      throw new Error('Displayed query does not match token');
    if (payload.resolvedLandingUrl) {
      if (normalizedHost(payload.resolvedLandingUrl) !== grant.target_domain)
        throw new Error('Captured landing URL is outside the fixed target domain');
      if (payload.rawHref) {
        const decoded = resolveGoogleHref(payload.rawHref);
        if (new URL(decoded).toString() !== new URL(payload.resolvedLandingUrl).toString())
          throw new Error('Resolved landing URL does not match raw Google href');
      }
    }
    const deviceProvenance = classifyRealBrowserDevice(payload.userAgent);
    const machineCapture = {
      blocked: false,
      displayedTitle: payload.displayedTitle,
      displayedSnippet: payload.displayedSnippet,
      rawGoogleHref: payload.rawHref,
      resolvedLandingUrl: payload.resolvedLandingUrl,
      approximateOrganicPosition: payload.approximateOrganicPosition,
      features: payload.features,
      lowConfidenceFields: payload.lowConfidenceFields,
      parserVersion: payload.collectorVersion,
      positionExtractionVersion: 'organic-position-v1',
      provenance: 'OWNER_ASSISTED_BROWSER_CAPTURE',
      deviceProvenance,
      browserContext: {
        userAgent: payload.userAgent,
        viewport: payload.viewport,
        timezone: payload.timezone,
      },
      ownerDeclaredLocation: grant.owner_declared_location,
      googleDisplayedLocation: payload.googleDisplayedLocation,
    };
    const inserted = await client.query(
      `INSERT INTO serp_captures(site_id,opportunity_id,request_id,status,query,target_domain,
       device_provenance,requested_location_label,timezone,google_displayed_location,
       capture_network_context,machine_capture,parser_version,position_extraction_version,captured_at)
       VALUES($1,$2,$3,'CAPTURED',$4,$5,$6,$7,$8,$9,'REAL_BROWSER_SESSION',$10::jsonb,$11,$12,$13)
       RETURNING *`,
      [
        grant.site_id,
        grant.opportunity_id,
        grant.request_id,
        grant.expected_query,
        grant.target_domain,
        deviceProvenance,
        grant.owner_declared_location,
        payload.timezone,
        payload.googleDisplayedLocation,
        JSON.stringify(machineCapture),
        ASSISTED_CAPTURE_VERSION,
        'organic-position-v1',
        capturedAt,
      ],
    );
    await client.query(`UPDATE browser_capture_tokens SET consumed_at=now() WHERE id=$1`, [
      grant.id,
    ]);
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type OwnerFactRequirement = {
  factKey: string;
  label: string;
  scopeType: (typeof ownerFactScopeTypes)[number];
  scopeKey: string;
  reviewDays: number;
  expectedValue?: unknown;
};

const notebookFacts: OwnerFactRequirement[] = [
  {
    factKey: 'service.notebook.accepted',
    label: 'Accepts second-hand notebooks',
    scopeType: 'SERVICE',
    scopeKey: 'notebook',
    reviewDays: 365,
  },
  {
    factKey: 'service.notebook.condition_coverage',
    label: 'Accepts normal, damaged, and non-working notebooks for consideration',
    scopeType: 'SERVICE',
    scopeKey: 'notebook',
    reviewDays: 180,
  },
  {
    factKey: 'service.notebook.preliminary_valuation',
    label: 'Photo/spec preliminary valuation is available',
    scopeType: 'SERVICE',
    scopeKey: 'notebook',
    reviewDays: 180,
  },
  {
    factKey: 'service.notebook.final_inspection',
    label: 'Final price follows physical inspection and agreement',
    scopeType: 'SERVICE',
    scopeKey: 'notebook',
    reviewDays: 180,
  },
  {
    factKey: 'location.physical_shop.ubon',
    label: 'Physical shop exists in Ubon Ratchathani',
    scopeType: 'GEOGRAPHY',
    scopeKey: 'ubon-ratchathani',
    reviewDays: 730,
  },
  {
    factKey: 'service.notebook.pickup_coverage',
    label: 'Notebook pickup coverage includes Ubon and the Northeast',
    scopeType: 'SERVICE_GEOGRAPHY',
    scopeKey: 'notebook|ubon-and-northeast',
    reviewDays: 90,
  },
];

const companyComputerScope = {
  service: 'company-computer',
  productCategory: 'company-computer-equipment',
  nationwide: 'company-computer|thailand',
} as const;

const acceptedDeviceTypes = ['DESKTOP_PC', 'MINI_PC', 'WORKSTATION', 'NOTEBOOK'] as const;
const valuationInputs = [
  'PHOTOS',
  'SPECIFICATIONS',
  'QUANTITY',
  'SERIAL_NUMBERS',
  'ASSET_TAGS',
  'EXCEL_OR_INVENTORY_LIST',
] as const;

export const companyComputerOwnerFactValues = [
  {
    factKey: 'service.accepted_device_types',
    label: 'Accepted company-computer device types',
    scopeType: 'PRODUCT_CATEGORY',
    scopeKey: companyComputerScope.productCategory,
    value: [...acceptedDeviceTypes],
    reviewDays: 180,
  },
  {
    factKey: 'service.accepts_defective_devices',
    label: 'Defective or non-working company computers may be accepted',
    scopeType: 'PRODUCT_CATEGORY',
    scopeKey: companyComputerScope.productCategory,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.accepts_multi_unit_lots',
    label: 'Mixed and multi-unit computer lots may be accepted',
    scopeType: 'PRODUCT_CATEGORY',
    scopeKey: companyComputerScope.productCategory,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.pickup_nationwide',
    label: 'Company pickup is available nationwide in Thailand',
    scopeType: 'SERVICE_GEOGRAPHY',
    scopeKey: companyComputerScope.nationwide,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.valuation_inputs_supported',
    label: 'Supported preliminary valuation inputs',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: [...valuationInputs],
    reviewDays: 180,
  },
  {
    factKey: 'service.preliminary_valuation_available',
    label: 'Preliminary valuation is available',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.quotation_available',
    label: 'A quotation can be provided before the transaction',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.final_price_after_inspection',
    label: 'Final price is confirmed after inspection',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.purchase_transaction_document_available',
    label: 'Purchase-related transaction documentation is available',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.seller_receipt_expected',
    label: 'The selling company is expected to issue a receipt for payment received',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.data_removal_available',
    label: 'Data removal or destruction can be provided',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.payment_cash_available',
    label: 'Cash payment is available',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
  {
    factKey: 'service.payment_bank_transfer_available',
    label: 'Bank-transfer payment is available',
    scopeType: 'SERVICE',
    scopeKey: companyComputerScope.service,
    value: true,
    reviewDays: 180,
  },
] as const satisfies ReadonlyArray<OwnerFactRequirement & { value: unknown }>;

export type DirectOwnerFactKey = (typeof companyComputerOwnerFactValues)[number]['factKey'];

const directOwnerFactDefinitions = new Map(
  companyComputerOwnerFactValues.map((item) => [item.factKey, item]),
);

function canonicalDirectFactValue(
  definition: (typeof companyComputerOwnerFactValues)[number],
  value: unknown,
) {
  if (Array.isArray(definition.value)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
      throw new Error('Canonical owner fact value must be a string array');
    const allowed = new Set(definition.value as readonly string[]);
    if (!value.length || value.some((item) => !allowed.has(item)))
      throw new Error('Owner fact value contains an unsupported canonical value');
    return [...new Set(value)].sort(
      (a, b) =>
        (definition.value as readonly string[]).indexOf(a) -
        (definition.value as readonly string[]).indexOf(b),
    );
  }
  if (typeof value !== 'boolean') throw new Error('Canonical owner fact value must be boolean');
  return value;
}

const canonicalJson = (value: unknown) => JSON.stringify(value);

export type DirectOwnerFactInput = {
  siteId: string;
  factKey: DirectOwnerFactKey;
  value: unknown;
  scopeType: (typeof ownerFactScopeTypes)[number];
  scopeKey: string;
  provenance: 'OWNER_CONFIRMED_DIRECT';
  reviewStatus: 'OWNER_CONFIRMED';
  confirmedBy: string;
  sourceContext?: string;
  ownerAuthorized: true;
};

export async function confirmDirectOwnerFact(
  input: DirectOwnerFactInput,
  pool: Pool = getDatabase().pool,
) {
  if (input.ownerAuthorized !== true) throw new Error('Explicit owner authorization is required');
  if (input.provenance !== 'OWNER_CONFIRMED_DIRECT')
    throw new Error('Direct owner confirmation provenance is required');
  if (input.reviewStatus !== 'OWNER_CONFIRMED')
    throw new Error('Direct owner confirmation review is required');
  const confirmedBy = input.confirmedBy.trim();
  if (!confirmedBy || confirmedBy.length > 100)
    throw new Error('Valid confirmer identity is required');
  const sourceContext = input.sourceContext?.trim() || null;
  if (sourceContext && sourceContext.length > 200) throw new Error('Source context is too long');
  const definition = directOwnerFactDefinitions.get(input.factKey);
  if (!definition) throw new Error('Unsupported canonical owner fact key');
  if (input.scopeType !== definition.scopeType || input.scopeKey !== definition.scopeKey)
    throw new Error('Owner fact scope does not match its canonical definition');
  const value = canonicalDirectFactValue(definition, input.value);
  const logicalHash = evidenceHash({
    registryVersion: 2,
    siteId: input.siteId,
    factKey: definition.factKey,
    value,
    scopeType: definition.scopeType,
    scopeKey: definition.scopeKey,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const site = await client.query(`SELECT id FROM sites WHERE id=$1 FOR SHARE`, [input.siteId]);
    if (!site.rows[0]) throw new Error('Site not found');
    const confirmation = (
      await client.query(
        `INSERT INTO owner_fact_confirmations(site_id,provenance,confirmed_by,review_status,
          source_context,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
        [
          input.siteId,
          input.provenance,
          confirmedBy,
          input.reviewStatus,
          sourceContext,
          JSON.stringify({ registryVersion: 2 }),
        ],
      )
    ).rows[0];
    const equivalent = await client.query(
      `SELECT * FROM owner_facts WHERE site_id=$1 AND fact_key=$2 AND scope_type=$3
        AND scope_key=$4 AND value_json=$5::jsonb ORDER BY confirmed_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [
        input.siteId,
        definition.factKey,
        definition.scopeType,
        definition.scopeKey,
        canonicalJson(value),
      ],
    );
    let fact = equivalent.rows[0];
    let created = false;
    let requiresReview = fact?.status === 'SUPERSEDED';
    if (!fact) {
      const inserted = await client.query(
        `INSERT INTO owner_facts(site_id,fact_key,value_json,scope_type,scope_key,status,review_after,
          direct_confirmation_id,confirmed_by,fact_hash,metadata)
         VALUES($1,$2,$3::jsonb,$4,$5,'ACTIVE',now()+($6::int*interval '1 day'),$7,$8,$9,$10::jsonb)
         ON CONFLICT(fact_hash) DO NOTHING RETURNING *`,
        [
          input.siteId,
          definition.factKey,
          canonicalJson(value),
          definition.scopeType,
          definition.scopeKey,
          definition.reviewDays,
          confirmation.id,
          confirmedBy,
          logicalHash,
          JSON.stringify({ registryVersion: 2, reviewDays: definition.reviewDays }),
        ],
      );
      fact = inserted.rows[0];
      created = Boolean(fact);
      if (!fact)
        fact = (
          await client.query(`SELECT * FROM owner_facts WHERE fact_hash=$1 FOR UPDATE`, [
            logicalHash,
          ])
        ).rows[0];
    } else if (fact.status === 'ACTIVE' || fact.status === 'EXPIRED') {
      fact = (
        await client.query(
          `UPDATE owner_facts SET status='ACTIVE',confirmed_at=now(),review_after=now()+($2::int*interval '1 day'),
            confirmed_by=$3,updated_at=now() WHERE id=$1 RETURNING *`,
          [fact.id, definition.reviewDays, confirmedBy],
        )
      ).rows[0];
      requiresReview = false;
    }
    if (!fact) throw new Error('Owner fact identity could not be resolved');
    await client.query(
      `INSERT INTO owner_fact_confirmation_links(fact_id,confirmation_id) VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [fact.id, confirmation.id],
    );
    const conflicts = await client.query(
      `SELECT id,value_json FROM owner_facts WHERE site_id=$1 AND fact_key=$2 AND scope_type=$3
        AND scope_key=$4 AND status='ACTIVE' AND (review_after IS NULL OR review_after>now())
        ORDER BY confirmed_at DESC,id DESC`,
      [input.siteId, definition.factKey, definition.scopeType, definition.scopeKey],
    );
    const conflict = new Set(conflicts.rows.map((row) => canonicalJson(row.value_json))).size > 1;
    await client.query('COMMIT');
    return { fact, confirmation, created, reused: !created, conflict, requiresReview };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function requiredOwnerFacts(input: { query?: string | null }): OwnerFactRequirement[] {
  const query = String(input.query ?? '').toLocaleLowerCase('th');
  if (query.includes('รับซื้อคอมบริษัท') || query.includes('คอมบริษัท'))
    return companyComputerOwnerFactValues.map((item) => ({
      factKey: item.factKey,
      label: item.label,
      scopeType: item.scopeType,
      scopeKey: item.scopeKey,
      reviewDays: item.reviewDays,
      expectedValue: item.value,
    }));
  if (query.includes('โน๊ตบุ๊ค') || query.includes('โน้ตบุ๊ก')) return notebookFacts;
  return [];
}

export function classifyOwnerFactCandidates(
  requirement: OwnerFactRequirement,
  facts: Array<Record<string, unknown>>,
  now = Date.now(),
) {
  const scoped = facts.filter(
    (fact) =>
      fact.fact_key === requirement.factKey &&
      fact.scope_type === requirement.scopeType &&
      fact.scope_key === requirement.scopeKey,
  );
  const active = scoped.filter(
    (fact) =>
      fact.status === 'ACTIVE' &&
      (!fact.review_after || new Date(String(fact.review_after)).getTime() > now),
  );
  const expired = scoped.some(
    (fact) =>
      fact.status === 'EXPIRED' ||
      (fact.review_after && new Date(String(fact.review_after)).getTime() <= now),
  );
  const conflict = new Set(active.map((fact) => JSON.stringify(fact.value_json))).size > 1;
  const match =
    !conflict && active.length > 0
      ? (active.find(
          (fact) =>
            requirement.expectedValue === undefined ||
            canonicalJson(fact.value_json) === canonicalJson(requirement.expectedValue),
        ) ?? null)
      : null;
  return { requirement, match, conflict, expired, candidates: scoped };
}

function factIdentity(input: {
  siteId: string;
  factKey: string;
  value: unknown;
  scopeType: string;
  scopeKey: string;
  sourceEvidenceItemId: string;
}) {
  return evidenceHash(input);
}

async function staleCurrentV3(opportunityId: string, pool: Pool) {
  return pool.query(
    `UPDATE source_change_plans p SET status='STALE',stale_at=now(),updated_at=now()
     FROM source_plan_runs r WHERE p.run_id=r.id AND r.opportunity_id=$1
       AND r.prompt_version='source-change-plan-prompt-v3'
       AND p.status IN ('READY_FOR_REVIEW','APPROVED') RETURNING p.id`,
    [opportunityId],
  );
}

export async function ownerFactStateForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const opportunity = await pool.query(`SELECT site_id,query FROM opportunities WHERE id=$1`, [
    opportunityId,
  ]);
  if (!opportunity.rows[0]) throw new Error('Opportunity not found');
  const requirements = requiredOwnerFacts(opportunity.rows[0]);
  const facts = requirements.length
    ? await pool.query(
        `SELECT * FROM owner_facts WHERE site_id=$1 AND fact_key=ANY($2::text[])
         ORDER BY confirmed_at DESC,id DESC`,
        [opportunity.rows[0].site_id, requirements.map((item) => item.factKey)],
      )
    : { rows: [] as Record<string, unknown>[] };
  const states = requirements.map((requirement) =>
    classifyOwnerFactCandidates(requirement, facts.rows),
  );
  return {
    siteId: String(opportunity.rows[0].site_id),
    requirements: states,
    complete: states.length > 0 && states.every((state) => Boolean(state.match)),
  };
}

export async function confirmReusableOwnerFact(
  input: { opportunityId: string; requestId: string; factKey: string; confirmedBy?: string },
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await client.query(
      `SELECT r.*,o.site_id,o.query FROM evidence_requests r JOIN opportunities o ON o.id=r.opportunity_id
       WHERE r.id=$1 AND r.opportunity_id=$2 AND r.type='OWNER_BUSINESS_CONFIRMATION' FOR UPDATE OF r`,
      [input.requestId, input.opportunityId],
    );
    if (!request.rows[0]) throw new Error('Owner business confirmation request required');
    const requirement = requiredOwnerFacts(request.rows[0]).find(
      (item) => item.factKey === input.factKey,
    );
    if (!requirement)
      throw new Error('Fact is not deterministically required for this opportunity');
    const value = requirement.expectedValue ?? true;
    const directEvidence = {
      factKey: requirement.factKey,
      value,
      scopeType: requirement.scopeType,
      scopeKey: requirement.scopeKey,
      provenance: 'OWNER_CONFIRMED_DIRECT',
      confirmedBy: input.confirmedBy ?? 'LOCAL_OWNER',
      registryVersion: 1,
    };
    const evidenceItem = await recordEvidenceItem(
      input.requestId,
      'OWNER_CONFIRMED_DIRECT',
      directEvidence,
      undefined,
      client as unknown as Pool,
    );
    const hash = factIdentity({
      siteId: String(request.rows[0].site_id),
      factKey: requirement.factKey,
      value,
      scopeType: requirement.scopeType,
      scopeKey: requirement.scopeKey,
      sourceEvidenceItemId: String(evidenceItem.id),
    });
    await client.query(
      `INSERT INTO owner_facts(site_id,fact_key,value_json,scope_type,scope_key,status,review_after,
       source_evidence_item_id,confirmed_by,fact_hash,metadata)
       VALUES($1,$2,$3::jsonb,$4,$5,'ACTIVE',now()+($6::int*interval '1 day'),$7,$8,$9,$10::jsonb)
       ON CONFLICT(fact_hash) DO NOTHING`,
      [
        request.rows[0].site_id,
        requirement.factKey,
        JSON.stringify(value),
        requirement.scopeType,
        requirement.scopeKey,
        requirement.reviewDays,
        evidenceItem.id,
        input.confirmedBy ?? 'LOCAL_OWNER',
        hash,
        JSON.stringify({ registryVersion: 1, reviewDays: requirement.reviewDays }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await staleCurrentV3(input.opportunityId, pool);
  return autoResolveOwnerBusinessConfirmation(input.opportunityId, pool);
}

export async function autoResolveOwnerBusinessConfirmation(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const state = await ownerFactStateForOpportunity(opportunityId, pool);
  if (!state.complete) return { resolved: false, state };
  const request = await pool.query(
    `SELECT id,status FROM evidence_requests WHERE opportunity_id=$1 AND type='OWNER_BUSINESS_CONFIRMATION'
     AND status<>'SUPERSEDED' ORDER BY created_at DESC LIMIT 1`,
    [opportunityId],
  );
  if (!request.rows[0] || request.rows[0].status === 'RESOLVED') return { resolved: false, state };
  const facts = state.requirements.map((item) => {
    const match = item.match!;
    return {
      factId: match.id,
      factKey: match.fact_key,
      value: match.value_json,
      scopeType: match.scope_type,
      scopeKey: match.scope_key,
      factHash: match.fact_hash,
      originalEvidenceItemId: match.source_evidence_item_id,
      provenance: 'OWNER_CONFIRMED_REUSED',
    };
  });
  const item = await recordEvidenceItem(
    String(request.rows[0].id),
    'OWNER_CONFIRMED_REUSED',
    { provenance: 'OWNER_CONFIRMED_REUSED', facts, registryVersion: 1 },
    undefined,
    pool,
  );
  await pool.query(`UPDATE evidence_requests SET status='RESOLVED',updated_at=now() WHERE id=$1`, [
    request.rows[0].id,
  ]);
  await staleCurrentV3(opportunityId, pool);
  return { resolved: true, item, state };
}

export async function evidenceAutomationPanelForOpportunity(
  opportunityId: string,
  pool: Pool = getDatabase().pool,
) {
  const [facts, captures, apiCaptures] = await Promise.all([
    ownerFactStateForOpportunity(opportunityId, pool),
    pool.query(`SELECT * FROM serp_captures WHERE opportunity_id=$1 ORDER BY created_at DESC`, [
      opportunityId,
    ]),
    pool.query(`SELECT * FROM serp_api_captures WHERE opportunity_id=$1 ORDER BY created_at DESC`, [
      opportunityId,
    ]),
  ]);
  return { facts, captures: captures.rows, apiCaptures: apiCaptures.rows };
}

export async function enqueueSerpCapture(
  input: {
    opportunityId: string;
    requestId: string;
    deviceProvenance: 'EMULATED_DESKTOP' | 'EMULATED_MOBILE';
    requestedLocationLabel: string;
    timezone: string;
    latitude?: number | null;
    longitude?: number | null;
  },
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(820242)');
    const active = await client.query(
      `SELECT c.*,j.id active_job_id FROM serp_captures c JOIN jobs j ON j.id=c.job_id
       WHERE c.request_id=$1 AND j.status IN ('QUEUED','RUNNING') ORDER BY c.created_at DESC LIMIT 1`,
      [input.requestId],
    );
    if (active.rows[0]) {
      await client.query('COMMIT');
      return { ...active.rows[0], job_id: active.rows[0].active_job_id, deduplicated: true };
    }
    const selected = await client.query(
      `SELECT r.type,r.status,o.site_id,o.query,s.url FROM evidence_requests r
       JOIN opportunities o ON o.id=r.opportunity_id JOIN sites s ON s.id=o.site_id
       WHERE r.id=$1 AND r.opportunity_id=$2 FOR UPDATE OF r`,
      [input.requestId, input.opportunityId],
    );
    const row = selected.rows[0];
    if (!row || row.type !== 'MANUAL_SERP_OBSERVATION')
      throw new Error('SERP evidence request required');
    if (!row.query) throw new Error('Opportunity query required');
    const targetDomain = new URL(row.url).hostname.replace(/^www\./, '');
    const capture = await client.query(
      `INSERT INTO serp_captures(site_id,opportunity_id,request_id,query,target_domain,device_provenance,
       requested_location_label,requested_geolocation,timezone)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
      [
        row.site_id,
        input.opportunityId,
        input.requestId,
        row.query,
        targetDomain,
        input.deviceProvenance,
        input.requestedLocationLabel,
        input.latitude != null && input.longitude != null
          ? JSON.stringify({ latitude: input.latitude, longitude: input.longitude })
          : null,
        input.timezone,
      ],
    );
    const job = await client.query(
      `INSERT INTO jobs(site_id,type,status,heavy,payload)
       VALUES($1,'CAPTURE_SERP','QUEUED',true,$2::jsonb) RETURNING *`,
      [
        row.site_id,
        JSON.stringify({
          captureId: capture.rows[0].id,
          requestId: input.requestId,
          opportunityId: input.opportunityId,
        }),
      ],
    );
    await client.query(`UPDATE serp_captures SET job_id=$2 WHERE id=$1`, [
      capture.rows[0].id,
      job.rows[0].id,
    ]);
    await client.query(`INSERT INTO job_events(job_id,event) VALUES($1,'ENQUEUED')`, [
      job.rows[0].id,
    ]);
    await client.query('COMMIT');
    return {
      ...capture.rows[0],
      job_id: job.rows[0].id,
      replacingResolvedEvidence: row.status === 'RESOLVED',
      deduplicated: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function prepareSerpCaptureJob(captureId: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `UPDATE serp_captures SET status='CAPTURING',updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING *`,
    [captureId],
  );
  if (!result.rows[0]) throw new Error('Queued SERP capture required');
  return result.rows[0];
}

export async function persistSerpCaptureSuccess(
  captureId: string,
  result: {
    extraction: unknown;
    screenshotPath: string;
    screenshotSha256: string;
    googleDisplayedLocation: string | null;
    capturedAt: Date;
  },
  pool: Pool = getDatabase().pool,
) {
  const extraction = result.extraction as Record<string, unknown>;
  const blocked = extraction.blocked === true;
  return (
    await pool.query(
      `UPDATE serp_captures SET status=$2,machine_capture=$3::jsonb,screenshot_path=$4,screenshot_sha256=$5,
       google_displayed_location=$6,parser_version=$7,position_extraction_version=$8,captured_at=$9,
       failure_code=$10,failure_summary=$11,updated_at=now() WHERE id=$1 RETURNING *`,
      [
        captureId,
        blocked ? 'CAPTURE_BLOCKED' : 'CAPTURED',
        JSON.stringify(extraction),
        result.screenshotPath,
        result.screenshotSha256,
        result.googleDisplayedLocation,
        extraction.parserVersion,
        extraction.positionExtractionVersion,
        result.capturedAt,
        blocked ? 'CAPTURE_BLOCKED' : null,
        blocked ? String(extraction.blockedReason ?? 'Google challenge') : null,
      ],
    )
  ).rows[0];
}

export async function persistSerpCaptureFailure(
  captureId: string,
  code: string,
  summary: string,
  pool: Pool = getDatabase().pool,
) {
  return pool.query(
    `UPDATE serp_captures SET status='FAILED',failure_code=$2,failure_summary=$3,updated_at=now() WHERE id=$1`,
    [captureId, code, summary.slice(0, 500)],
  );
}

export async function confirmSerpCapture(
  input: {
    opportunityId: string;
    captureId: string;
    displayedTitle: string;
    displayedSnippet: string;
    rankingUrl: string;
    approximateOrganicPosition: number | null;
    serpFeatures: string[];
  },
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM serp_captures WHERE id=$1 AND opportunity_id=$2 AND status='CAPTURED' FOR UPDATE`,
      [input.captureId, input.opportunityId],
    );
    const capture = selected.rows[0];
    if (!capture) throw new Error('Captured SERP observation required');
    const machine = capture.machine_capture as Record<string, unknown>;
    if (normalizedHost(input.rankingUrl) !== capture.target_domain)
      throw new Error('Confirmed ranking URL is outside the fixed target domain');
    const owner = {
      query: capture.query,
      observedAt: new Date(capture.captured_at).toISOString(),
      observedTimezone: capture.timezone,
      requestedLocationLabel: capture.requested_location_label,
      ownerDeclaredLocation: capture.requested_location_label,
      requestedGeolocation: capture.requested_geolocation,
      googleDisplayedLocation: capture.google_displayed_location ?? 'UNKNOWN',
      captureNetworkContext: capture.capture_network_context ?? 'UNKNOWN',
      deviceProvenance: capture.device_provenance,
      displayedTitle: input.displayedTitle,
      displayedSnippet: input.displayedSnippet,
      rankingUrl: new URL(input.rankingUrl).toString(),
      approximatePosition: input.approximateOrganicPosition,
      serpFeatures: input.serpFeatures,
      screenshotPath: capture.screenshot_path,
      screenshotSha256: capture.screenshot_sha256,
      parserVersion: capture.parser_version,
      positionExtractionVersion: capture.position_extraction_version,
      machineCapturedValue: machine,
      provenance: 'OWNER_CONFIRMED_BROWSER_CAPTURE',
      ownerConfirmedAt: new Date().toISOString(),
    };
    const corrected =
      input.displayedTitle !== String(machine.displayedTitle ?? '') ||
      input.displayedSnippet !== String(machine.displayedSnippet ?? '') ||
      input.rankingUrl !== String(machine.resolvedLandingUrl ?? '') ||
      input.approximateOrganicPosition !== (machine.approximateOrganicPosition ?? null) ||
      JSON.stringify([...input.serpFeatures].sort()) !==
        JSON.stringify(
          Object.entries((machine.features ?? {}) as Record<string, unknown>)
            .filter(([, value]) => value === 'PRESENT')
            .map(([key]) => key)
            .sort(),
        );
    await recordEvidenceItem(
      String(capture.request_id),
      'OWNER_CONFIRMED_BROWSER_CAPTURE',
      owner,
      new Date(capture.captured_at),
      client as unknown as Pool,
      String(capture.timezone),
    );
    await client.query(
      `UPDATE evidence_requests SET status='RESOLVED',updated_at=now() WHERE id=$1`,
      [capture.request_id],
    );
    await client.query(
      `UPDATE serp_captures SET status='CONFIRMED',owner_confirmed_value=$2::jsonb,corrected=$3,
       confirmed_at=now(),updated_at=now() WHERE id=$1`,
      [input.captureId, JSON.stringify(owner), corrected],
    );
    await staleCurrentV3(input.opportunityId, client as unknown as Pool);
    await client.query('COMMIT');
    return { corrected };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function discardSerpCapture(captureId: string, pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `UPDATE serp_captures SET status='DISCARDED',discarded_at=now(),updated_at=now()
     WHERE id=$1 AND status IN ('CAPTURED','CAPTURE_BLOCKED','FAILED') RETURNING *`,
    [captureId],
  );
  if (!result.rows[0]) throw new Error('Reviewable SERP capture required');
  return result.rows[0];
}
