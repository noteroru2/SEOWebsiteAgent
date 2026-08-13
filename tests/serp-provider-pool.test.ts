import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createServer } from 'node:http';
import {
  capabilityMismatch,
  classifyEvidenceRequirement,
  PROVIDER_CAPABILITIES,
  SerpApiProvider,
  SerperProvider,
  SerpstackProvider,
  selectProvider,
  type NormalizedSerpResult,
} from '@seo-agent/serp-providers';
import {
  configureSerpProvider,
  acceptSerpApiCapture,
  assertFreeOnlyMode,
  createDatabase,
  createSite,
  deterministicEvidencePacket,
  enqueueSerpApiCapture,
  ensureEvidenceRequest,
  invalidateSerpApiCapture,
  persistSerpApiFailure,
  persistSerpApiSuccess,
  rejectSerpApiCapture,
  reserveSerpProviderAttempt,
  serpProviderStatus,
  storeOwnerEvidence,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const requirement = classifyEvidenceRequirement({
  query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
  requestedLocation: 'Ubon Ratchathani, Thailand',
  device: 'MOBILE',
});

const unicodeQueryMatrix = [
  'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
  'รับซื้อ ram',
  'อำพล เทรดดิ้ง',
  'รับซื้อโทรศัพท์ใกล้ฉัน',
  'mac mini m4 มือสอง',
  'รับ ซื้อ โน๊ต บุ๊ค',
  'รับซื้อ notebook RAM 16GB',
  'โน๊ตบุ๊ค/มือถือ + RAM?',
] as const;

const candidate = (
  provider: 'SERPAPI' | 'SERPSTACK' | 'SERPER',
  overrides: Record<string, unknown> = {},
) => ({
  provider,
  enabled: true,
  configured: true,
  health: 'AVAILABLE',
  remaining: 10,
  priority: provider === 'SERPAPI' ? 10 : provider === 'SERPSTACK' ? 20 : 30,
  capabilities: PROVIDER_CAPABILITIES[provider],
  ...overrides,
});

describe('capability-based free-only routing', () => {
  it('rejects every non-free billing mode', () => {
    expect(assertFreeOnlyMode({ SERP_BILLING_MODE: 'FREE_ONLY' })).toBe('FREE_ONLY');
    expect(() => assertFreeOnlyMode({ SERP_BILLING_MODE: 'PAID' })).toThrow('FREE_ONLY');
  });
  it('selects a city/mobile-capable provider for a local query', () => {
    expect(selectProvider(requirement, [candidate('SERPAPI'), candidate('SERPER')])).toBe(
      'SERPAPI',
    );
  });
  it('rejects country-only evidence for CITY and desktop-only evidence for MOBILE', () => {
    expect(capabilityMismatch(PROVIDER_CAPABILITIES.SERPER, requirement)).toBe(
      'LOCATION_PRECISION_MISMATCH',
    );
    expect(
      capabilityMismatch({ ...PROVIDER_CAPABILITIES.SERPAPI, supportsMobile: false }, requirement),
    ).toBe('DEVICE_MISMATCH');
  });
  it('falls back without downgrading when no eligible API remains', () => {
    expect(
      selectProvider(requirement, [
        candidate('SERPAPI', { remaining: 0 }),
        candidate('SERPSTACK', { health: 'RATE_LIMITED' }),
        candidate('SERPER'),
      ]),
    ).toBeNull();
  });
  it('prefers Serper for national desktop evidence while free credits remain', () => {
    const national = classifyEvidenceRequirement({ query: 'รับซื้อโน๊ตบุ๊ค', device: 'DESKTOP' });
    expect(
      selectProvider(national, [candidate('SERPAPI'), candidate('SERPSTACK'), candidate('SERPER')]),
    ).toBe('SERPER');
  });
});

const providerResponse = (provider: 'SERPAPI' | 'SERPSTACK' | 'SERPER') => {
  const organic = [
    {
      position: 1,
      title: 'Other',
      snippet: 'Other result',
      link: 'https://example.com/',
      url: 'https://example.com/',
    },
    {
      position: 2,
      title: 'รับซื้อโน๊ตบุ๊ค อุบลราชธานี',
      snippet: 'ประเมินราคาโน๊ตบุ๊ค',
      link: 'https://amphon.co.th/notebook',
      url: 'https://amphon.co.th/notebook',
    },
    {
      position: 3,
      title: 'Duplicate',
      snippet: 'duplicate',
      link: 'https://amphon.co.th/notebook',
      url: 'https://amphon.co.th/notebook',
    },
  ];
  if (provider === 'SERPAPI')
    return {
      search_metadata: { id: 'serpapi-id' },
      search_parameters: { location_used: 'Ubon Ratchathani,Thailand' },
      organic_results: organic,
      ads: [{}],
      ai_overview: { text: 'overview' },
      local_results: [{}],
      related_questions: [{}],
      shopping_results: [{}],
    };
  if (provider === 'SERPSTACK')
    return {
      success: true,
      search_parameters: { location: 'Ubon Ratchathani, Thailand' },
      organic_results: organic,
      ads: [],
      local_results: [{}],
      questions: [{}],
      shopping_results: [],
    };
  return { organic, ads: [{}], places: [], peopleAlsoAsk: [{}], shopping: [] };
};

describe.each([
  ['SERPAPI', SerpApiProvider],
  ['SERPSTACK', SerpstackProvider],
  ['SERPER', SerperProvider],
] as const)('%s adapter fixtures', (name, Adapter) => {
  it('normalizes Thai organic results, target position, features, location, device, and duplicates', async () => {
    let requested: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      requested = { url: String(url), init };
      return new Response(JSON.stringify(providerResponse(name)), { status: 200 });
    };
    const adapter = new Adapter('fixture-key', fakeFetch as typeof fetch);
    const input =
      name === 'SERPER'
        ? { ...requirement, requiredPrecision: 'COUNTRY' as const, device: 'DESKTOP' as const }
        : requirement;
    const result = await adapter.search(input, AbortSignal.timeout(1_000));
    expect(result.organicResults).toHaveLength(2);
    expect(result.targetOrganicPosition).toBe(2);
    expect(result.targetTitle).toContain('โน๊ตบุ๊ค');
    expect(result.targetSnippet).toContain('ประเมินราคา');
    expect(result.targetUrl).toBe('https://amphon.co.th/notebook');
    expect(result.features.ads).toBe(name === 'SERPSTACK' ? 'ABSENT' : 'PRESENT');
    expect(result.features.aiOverview).toBe(name === 'SERPAPI' ? 'PRESENT' : 'UNKNOWN');
    expect(result.features.peopleAlsoAsk).toBe('PRESENT');
    expect(result.device).toBe(input.device);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    if (name === 'SERPAPI' || name === 'SERPSTACK')
      expect(new URL(requested!.url).searchParams.get('num')).toBe('20');
    else expect(JSON.parse(String(requested!.init?.body)).num).toBe(20);
  });

  it('rejects malformed responses deterministically', async () => {
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response('{not-json', { status: 200 })) as typeof fetch,
    );
    await expect(adapter.search(requirement, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      category: 'MALFORMED_RESPONSE',
    });
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [402, 'FREE_QUOTA_EXHAUSTED'],
    [429, 'RATE_LIMITED'],
  ] as const)('classifies HTTP %s without exposing provider payloads', async (status, category) => {
    const adapter = new Adapter(
      'fixture-key',
      (async () =>
        new Response(JSON.stringify({ error: 'fixture-provider-detail' }), {
          status,
        })) as typeof fetch,
    );
    await expect(adapter.search(requirement, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      category,
    });
  });

  it('classifies provider-reported authentication failures without returning raw details', async () => {
    const response =
      name === 'SERPSTACK'
        ? { success: false, error: { type: 'invalid_access_key', info: 'fixture secret' } }
        : { error: 'invalid api key fixture secret' };
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response(JSON.stringify(response), { status: 400 })) as typeof fetch,
    );
    let caught: unknown;
    try {
      await adapter.search(requirement, AbortSignal.timeout(1_000));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ category: 'AUTH_FAILED' });
    expect(String((caught as Error).message)).not.toContain('fixture secret');
  });

  it('preserves target-absent evidence and marks unsupported feature fields unknown', async () => {
    const payload = providerResponse(name) as Record<string, unknown>;
    if (name === 'SERPER') payload.organic = [];
    else payload.organic_results = [];
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    );
    const input =
      name === 'SERPER'
        ? { ...requirement, requiredPrecision: 'COUNTRY' as const, device: 'DESKTOP' as const }
        : requirement;
    const result = await adapter.search(input, AbortSignal.timeout(1_000));
    expect(result.targetFound).toBe(false);
    expect(result.targetOrganicPosition).toBeNull();
    expect(result.features.aiOverview).toBe(name === 'SERPAPI' ? 'PRESENT' : 'UNKNOWN');
  });

  it('classifies a provider timeout as temporarily unavailable', async () => {
    const adapter = new Adapter('fixture-key', (async () => {
      throw new DOMException('fixture timeout', 'AbortError');
    }) as typeof fetch);
    await expect(adapter.search(requirement, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      category: 'TEMPORARILY_UNAVAILABLE',
      message: 'Provider request timed out',
    });
  });
});

describe('SerpApi Unicode HTTP transport', () => {
  it.each(unicodeQueryMatrix)(
    'preserves %s character-for-character through URL encoding and a local HTTP server',
    async (query) => {
      let received:
        | {
            query: string | null;
            location: string | null;
            device: string | null;
            hl: string | null;
            gl: string | null;
          }
        | undefined;
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        received = {
          query: url.searchParams.get('q'),
          location: url.searchParams.get('location'),
          device: url.searchParams.get('device'),
          hl: url.searchParams.get('hl'),
          gl: url.searchParams.get('gl'),
        };
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            search_metadata: { id: 'local-unicode-fixture' },
            search_parameters: { location_used: received.location },
            organic_results: [],
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Local fixture server unavailable');
        const adapter = new SerpApiProvider(
          'fixture-key',
          fetch,
          `http://127.0.0.1:${address.port}/search.json`,
        );
        await adapter.search(
          {
            ...requirement,
            query,
            requestedLocation: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
            device: 'MOBILE',
          },
          AbortSignal.timeout(2_000),
        );
        expect(received).toEqual({
          query,
          location: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
          device: 'mobile',
          hl: 'th',
          gl: 'th',
        });
        expect(decodeURIComponent(encodeURIComponent(query))).toBe(query);
        expect(query).not.toContain('\uFFFD');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

const database = createDatabase(requireTestDatabaseUrl());
let siteId = '';
let opportunityId = '';
let requestId = '';

const normalizedFixture = (): NormalizedSerpResult => ({
  provider: 'SERPAPI',
  providerRequestId: 'owner-review-fixture',
  query: requirement.query,
  requestedLocation: requirement.requestedLocation,
  providerLocationUsed: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
  locationPrecision: 'CITY',
  device: 'MOBILE',
  capturedAt: new Date().toISOString(),
  organicResults: [],
  features: {
    ads: 'UNKNOWN',
    aiOverview: 'UNKNOWN',
    mapPack: 'UNKNOWN',
    peopleAlsoAsk: 'UNKNOWN',
    shopping: 'UNKNOWN',
  },
  targetFound: true,
  targetOrganicPosition: 2,
  targetUrl: 'https://amphon.co.th/notebook',
  targetTitle: 'AMPHON',
  targetSnippet: 'Fixture',
});

async function seedProviderConfigs() {
  for (const [index, provider] of (['SERPAPI', 'SERPSTACK', 'SERPER'] as const).entries())
    await database.pool.query(
      `INSERT INTO serp_provider_configs(provider,enabled,allowance_type,configured_allowance,priority,capabilities)
       VALUES($1,false,$2,$3,$4,$5::jsonb)`,
      [
        provider,
        provider === 'SERPER' ? 'CREDIT_POOL' : 'MONTHLY',
        provider === 'SERPAPI' ? 250 : provider === 'SERPSTACK' ? 100 : 2500,
        (index + 1) * 10,
        JSON.stringify(PROVIDER_CAPABILITIES[provider]),
      ],
    );
}

async function setupOpportunity(fingerprint = 'provider-pool') {
  const opportunity = await database.pool.query(
    `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
     VALUES($1,'LOW_CTR_QUERY',$2,'Fixture','Evidence',$3,'OPEN') RETURNING id`,
    [siteId, requirement.query, fingerprint],
  );
  const req = await ensureEvidenceRequest(
    {
      opportunityId: opportunity.rows[0].id,
      type: 'MANUAL_SERP_OBSERVATION',
      requirement: 'SERP observation evidence required',
      reason: 'test',
      source: 'OWNER',
    },
    database.pool,
  );
  return { opportunityId: opportunity.rows[0].id as string, requestId: req.id as string };
}

describe('transactional free quota and evidence integration', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    await seedProviderConfigs();
    siteId = (
      await createSite({ name: 'Provider Fixture', url: 'https://amphon.co.th/' }, database.db)
    ).id;
    ({ opportunityId, requestId } = await setupOpportunity());
  });
  afterAll(async () => database.pool.end());

  it('does not queue a call at zero allowance and returns owner-browser fallback', async () => {
    const outcome = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: true, SERPER: true },
      database.pool,
    );
    expect(outcome).toMatchObject({ queued: false, fallback: 'OWNER_BROWSER' });
    expect(
      (await database.pool.query(`SELECT count(*)::int n FROM jobs WHERE type='FETCH_SERP_API'`))
        .rows[0].n,
    ).toBe(0);
  });

  it('reserves one allowance transactionally and blocks a concurrent second capture', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const first = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const secondIdentity = await setupOpportunity('provider-pool-second');
    const second = await enqueueSerpApiCapture(
      { ...secondIdentity, requestedLocation: requirement.requestedLocation, device: 'MOBILE' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(first.queued && second.queued).toBe(true);
    const [a, b] = await Promise.allSettled([
      reserveSerpProviderAttempt(
        first.capture!.id,
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
      ),
      reserveSerpProviderAttempt(
        second.capture!.id,
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
      ),
    ]);
    expect([a, b].filter((item) => item.status === 'fulfilled' && item.value)).toHaveLength(1);
    const status = await serpProviderStatus(
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(status.find((item) => item.provider === 'SERPAPI')).toMatchObject({
      used: 0,
      reserved: 1,
      remaining: 0,
    });
  });

  it('preserves the exact Thai query across opportunity, capture, job identity, and worker reservation', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const expected = 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน';
    expect(requirement.query).toBe(expected);
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(queued.queued).toBe(true);
    const persisted = await database.pool.query(
      `SELECT o.query opportunity_query,c.query capture_query,j.payload job_payload
       FROM serp_api_captures c JOIN opportunities o ON o.id=c.opportunity_id
       JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,
      [queued.capture!.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      opportunity_query: expected,
      capture_query: expected,
    });
    expect(persisted.rows[0].job_payload).toMatchObject({
      captureId: queued.capture!.id,
      requestId,
      opportunityId,
    });
    expect(JSON.stringify(persisted.rows[0].job_payload)).not.toContain('?');
    const attempt = await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(attempt?.requirement.query).toBe(expected);
  });

  it('persists review policy in capture/job identity and separates fingerprints', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 2,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const automatic = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
        reviewPolicy: 'AUTO_ACCEPT_IF_POLICY_ALLOWS',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const autoRow = (
      await database.pool.query(
        `SELECT c.request_fingerprint,c.review_policy,j.payload FROM serp_api_captures c
         JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,
        [automatic.capture!.id],
      )
    ).rows[0];
    expect(autoRow.review_policy).toBe('AUTO_ACCEPT_IF_POLICY_ALLOWS');
    expect(autoRow.payload.reviewPolicy).toBe('AUTO_ACCEPT_IF_POLICY_ALLOWS');
    await database.pool.query(`UPDATE jobs SET status='CANCELLED' WHERE id=$1`, [
      automatic.capture!.job_id,
    ]);
    await database.pool.query(`UPDATE serp_api_captures SET status='REJECTED' WHERE id=$1`, [
      automatic.capture!.id,
    ]);
    const reviewed = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const reviewRow = (
      await database.pool.query(
        `SELECT c.request_fingerprint,c.review_policy,j.payload FROM serp_api_captures c
         JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,
        [reviewed.capture!.id],
      )
    ).rows[0];
    expect(reviewRow.review_policy).toBe('OWNER_REVIEW_REQUIRED');
    expect(reviewRow.payload.reviewPolicy).toBe('OWNER_REVIEW_REQUIRED');
    expect(reviewRow.request_fingerprint).not.toBe(autoRow.request_fingerprint);
  });

  it('makes owner review override LOW_CTR auto-accept until one idempotent explicit acceptance', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const repository = await database.pool.query(
      `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/owner-review-fixture') RETURNING id`,
      [siteId],
    );
    const run = await database.pool.query(
      `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,finished_at)
       VALUES($1,$2,$3,'SUCCEEDED','fixture-model','medium','source-change-plan-prompt-v3','fixture-schema','fixture-head','old-evidence',now()) RETURNING id`,
      [siteId, opportunityId, repository.rows[0].id],
    );
    const plan = await database.pool.query(
      `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,batch5_reconciliation,summary,structured_output,status)
       VALUES($1,$2,$3,'NEEDS_MORE_EVIDENCE','MEDIUM','REFINED','Historical','{}','READY_FOR_REVIEW') RETURNING id`,
      [run.rows[0].id, siteId, opportunityId],
    );
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const attempt = await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(attempt?.capture.review_policy).toBe('OWNER_REVIEW_REQUIRED');
    expect(
      await persistSerpApiSuccess(queued.capture!.id, normalizedFixture(), database.pool),
    ).toEqual({
      accepted: false,
      pendingReview: true,
      conflict: false,
    });
    expect(
      (
        await database.pool.query(
          `SELECT status,normalized_result FROM serp_api_captures WHERE id=$1`,
          [queued.capture!.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'PENDING_REVIEW',
      normalized_result: { provenance: 'SERP_API_CAPTURED' },
    });
    expect(
      (await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [requestId]))
        .rows[0].status,
    ).toBe('OPEN');
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(before);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('READY_FOR_REVIEW');
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);

    await acceptSerpApiCapture(queued.capture!.id, database.pool);
    expect((await acceptSerpApiCapture(queued.capture!.id, database.pool)).idempotent).toBe(true);
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query(`SELECT status FROM serp_api_captures WHERE id=$1`, [
          queued.capture!.id,
        ])
      ).rows[0].status,
    ).toBe('ACCEPTED');
    expect(
      (await deterministicEvidencePacket(opportunityId, database.pool)).evidencePacketHash,
    ).not.toBe(before.evidencePacketHash);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('STALE');
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM jobs WHERE type IN ('ANALYZE_OPPORTUNITY','GENERATE_SOURCE_CHANGE_PLAN') AND status IN ('QUEUED','RUNNING')`,
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('rejects an owner-review capture without evidence, packet, request, or V3 side effects', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const repository = await database.pool.query(
      `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/reject-review-fixture') RETURNING id`,
      [siteId],
    );
    const run = await database.pool.query(
      `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,finished_at)
       VALUES($1,$2,$3,'SUCCEEDED','fixture-model','medium','source-change-plan-prompt-v3','fixture-schema','fixture-head','old-evidence',now()) RETURNING id`,
      [siteId, opportunityId, repository.rows[0].id],
    );
    const plan = await database.pool.query(
      `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,batch5_reconciliation,summary,structured_output,status)
       VALUES($1,$2,$3,'NEEDS_MORE_EVIDENCE','MEDIUM','REFINED','Historical','{}','READY_FOR_REVIEW') RETURNING id`,
      [run.rows[0].id, siteId, opportunityId],
    );
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await persistSerpApiSuccess(queued.capture!.id, normalizedFixture(), database.pool);
    const rejected = await rejectSerpApiCapture(queued.capture!.id, database.pool);
    expect(rejected).toMatchObject({ status: 'REJECTED', review_policy: 'OWNER_REVIEW_REQUIRED' });
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [requestId]))
        .rows[0].status,
    ).toBe('OPEN');
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(before);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('READY_FOR_REVIEW');
  });

  it('success consumes allowance, creates API provenance, hashes evidence, stales V3, and enqueues no AI', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 2,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const repository = await database.pool.query(
      `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/provider-fixture') RETURNING id`,
      [siteId],
    );
    const run = await database.pool.query(
      `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,finished_at)
       VALUES($1,$2,$3,'SUCCEEDED','fixture-model','medium','source-change-plan-prompt-v3','fixture-schema','fixture-head','old-evidence-hash',now()) RETURNING id`,
      [siteId, opportunityId, repository.rows[0].id],
    );
    const plan = await database.pool.query(
      `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,batch5_reconciliation,summary,structured_output,status)
       VALUES($1,$2,$3,'PROTECT_CURRENT_STATE','HIGH','REFINED','Historical','{}','READY_FOR_REVIEW') RETURNING id`,
      [run.rows[0].id, siteId, opportunityId],
    );
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const attempt = await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(attempt?.provider).toBe('SERPAPI');
    const result: NormalizedSerpResult = {
      provider: 'SERPAPI',
      providerRequestId: 'fixture',
      query: requirement.query,
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon Ratchathani,Thailand',
      locationPrecision: 'CITY',
      device: 'MOBILE',
      capturedAt: new Date().toISOString(),
      organicResults: [
        {
          position: 2,
          title: 'AMPHON',
          snippet: 'Thai',
          url: 'https://amphon.co.th/notebook',
          displayedUrl: 'amphon.co.th',
        },
      ],
      features: {
        ads: 'ABSENT',
        aiOverview: 'UNKNOWN',
        mapPack: 'PRESENT',
        peopleAlsoAsk: 'UNKNOWN',
        shopping: 'ABSENT',
      },
      targetFound: true,
      targetOrganicPosition: 2,
      targetUrl: 'https://amphon.co.th/notebook',
      targetTitle: 'AMPHON',
      targetSnippet: 'Thai',
    };
    await persistSerpApiSuccess(queued.capture!.id, result, database.pool);
    const item = (
      await database.pool.query(
        `SELECT source_type,evidence FROM evidence_items WHERE request_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [requestId],
      )
    ).rows[0];
    expect(item.source_type).toBe('SERP_API_CAPTURED');
    expect(item.evidence.evidenceQuality).toBe('SERP_API_CITY');
    expect(
      (await deterministicEvidencePacket(opportunityId, database.pool)).evidencePacketHash,
    ).not.toBe(before.evidencePacketHash);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('STALE');
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM jobs WHERE type IN ('ANALYZE_OPPORTUNITY','GENERATE_SOURCE_CHANGE_PLAN')`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
    const status = await serpProviderStatus(
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(status.find((entry) => entry.provider === 'SERPAPI')).toMatchObject({
      used: 1,
      reserved: 0,
      remaining: 1,
    });
  });

  it('keeps monthly and credit-pool allowance periods explicit and never resets them early', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 12,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    await configureSerpProvider(
      {
        provider: 'SERPER',
        enabled: true,
        configuredAllowance: 2500,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: null,
      },
      database.pool,
    );
    await database.pool.query(
      `UPDATE serp_provider_usage_periods SET used=3 WHERE provider='SERPAPI'
       AND period_start<=now() AND period_end>now()`,
    );
    await database.pool.query(
      `UPDATE serp_provider_usage_periods SET used=7 WHERE provider='SERPER'
       AND period_start<=now() AND period_end IS NULL`,
    );
    const status = await serpProviderStatus(
      { SERPAPI: true, SERPSTACK: false, SERPER: true },
      database.pool,
    );
    expect(status.find((entry) => entry.provider === 'SERPAPI')).toMatchObject({
      allowance_type: 'MONTHLY',
      used: 3,
      remaining: 9,
    });
    expect(status.find((entry) => entry.provider === 'SERPER')).toMatchObject({
      allowance_type: 'CREDIT_POOL',
      used: 7,
      remaining: 2493,
      period_end: null,
    });
  });

  it('quota exhaustion disables the provider and an uncertain failure consumes conservatively', async () => {
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 2,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await persistSerpApiFailure(
      {
        captureId: queued.capture!.id,
        provider: 'SERPAPI',
        category: 'FREE_QUOTA_EXHAUSTED',
        summary: 'quota',
      },
      database.pool,
    );
    const status = await serpProviderStatus(
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(status.find((entry) => entry.provider === 'SERPAPI')).toMatchObject({
      effective_health: 'FREE_QUOTA_EXHAUSTED',
      used: 1,
      reserved: 0,
    });
  });

  it('requires owner review before higher-risk API evidence resolves the request', async () => {
    await database.pool.query(
      `UPDATE opportunities SET kind='QUERY_PAGE_OVERLAP_CANDIDATE' WHERE id=$1`,
      [opportunityId],
    );
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const api = {
      provider: 'SERPAPI',
      providerRequestId: null,
      query: requirement.query,
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon',
      locationPrecision: 'CITY',
      device: 'MOBILE',
      capturedAt: new Date().toISOString(),
      organicResults: [],
      features: {
        ads: 'UNKNOWN',
        aiOverview: 'UNKNOWN',
        mapPack: 'UNKNOWN',
        peopleAlsoAsk: 'UNKNOWN',
        shopping: 'UNKNOWN',
      },
      targetFound: true,
      targetOrganicPosition: 2,
      targetUrl: 'https://amphon.co.th/notebook',
      targetTitle: 'API',
      targetSnippet: 'API',
    } satisfies NormalizedSerpResult;
    expect(await persistSerpApiSuccess(queued.capture!.id, api, database.pool)).toMatchObject({
      accepted: false,
      pendingReview: true,
    });
    expect(
      (await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [requestId]))
        .rows[0].status,
    ).toBe('OPEN');
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    await acceptSerpApiCapture(queued.capture!.id, database.pool);
    expect(
      (await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [requestId]))
        .rows[0].status,
    ).toBe('RESOLVED');
    expect(
      (
        await database.pool.query(`SELECT source_type FROM evidence_items WHERE request_id=$1`, [
          requestId,
        ])
      ).rows[0].source_type,
    ).toBe('OWNER_CONFIRMED_SERP_API_CAPTURE');
  });

  it('preserves conflicting owner evidence alongside API evidence', async () => {
    await storeOwnerEvidence(
      {
        requestId,
        sourceType: 'OWNER_OBSERVED_SERP',
        evidence: {
          query: requirement.query,
          location: 'Ubon',
          device: 'Mobile',
          displayedTitle: 'Owner',
          displayedSnippet: 'Owner',
          rankingUrl: 'https://amphon.co.th/notebook',
          approximatePosition: 5,
          serpFeatures: [],
        },
        observedAt: new Date(),
        observedTimezone: 'Asia/Bangkok',
      },
      database.pool,
    );
    await configureSerpProvider(
      {
        provider: 'SERPAPI',
        enabled: true,
        configuredAllowance: 1,
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
      },
      database.pool,
    );
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        requestedLocation: requirement.requestedLocation,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const api = {
      provider: 'SERPAPI',
      providerRequestId: null,
      query: requirement.query,
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon',
      locationPrecision: 'CITY',
      device: 'MOBILE',
      capturedAt: new Date().toISOString(),
      organicResults: [],
      features: {
        ads: 'UNKNOWN',
        aiOverview: 'UNKNOWN',
        mapPack: 'UNKNOWN',
        peopleAlsoAsk: 'UNKNOWN',
        shopping: 'UNKNOWN',
      },
      targetFound: true,
      targetOrganicPosition: 2,
      targetUrl: 'https://amphon.co.th/notebook',
      targetTitle: 'API',
      targetSnippet: 'API',
    } satisfies NormalizedSerpResult;
    const outcome = await persistSerpApiSuccess(queued.capture!.id, api, database.pool);
    expect(outcome.conflict).toBe(true);
    const rows = await database.pool.query(
      `SELECT source_type FROM evidence_items WHERE request_id=$1 ORDER BY created_at`,
      [requestId],
    );
    expect(rows.rows.map((row) => row.source_type)).toEqual([
      'OWNER_OBSERVED_SERP',
      'SERP_API_CAPTURED',
    ]);
  });

  it('invalidates a corrupted pending capture without changing evidence identity or V3 state', async () => {
    const repository = await database.pool.query(
      `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/unicode-fixture') RETURNING id`,
      [siteId],
    );
    const run = await database.pool.query(
      `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,status,model,reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash,finished_at)
       VALUES($1,$2,$3,'SUCCEEDED','fixture-model','medium','source-change-plan-prompt-v3','fixture-schema','fixture-head','fixture-evidence',now()) RETURNING id`,
      [siteId, opportunityId, repository.rows[0].id],
    );
    const plan = await database.pool.query(
      `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,batch5_reconciliation,summary,structured_output,status)
       VALUES($1,$2,$3,'NEEDS_MORE_EVIDENCE','MEDIUM','REFINED','Historical','{}','READY_FOR_REVIEW') RETURNING id`,
      [run.rows[0].id, siteId, opportunityId],
    );
    const corrupted = '??????????????? ???????';
    const capture = await database.pool.query(
      `INSERT INTO serp_api_captures(site_id,opportunity_id,request_id,provider,status,request_fingerprint,query,requested_location,required_precision,device,target_domain,normalized_result,provider_request_id,captured_at)
       VALUES($1,$2,$3,'SERPAPI','PENDING_REVIEW','unicode-invalid-fixture',$4,'Ubon Ratchathani,Ubon Ratchathani,Thailand','CITY','MOBILE','amphon.co.th',$5::jsonb,'fixture-request',now()) RETURNING id`,
      [siteId, opportunityId, requestId, corrupted, JSON.stringify({ query: corrupted })],
    );
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const evidenceCount = (
      await database.pool.query(`SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`, [
        requestId,
      ])
    ).rows[0].n;
    const invalid = await invalidateSerpApiCapture(
      capture.rows[0].id,
      'QUERY_TRANSPORT_CORRUPTED',
      database.pool,
    );
    expect(invalid).toMatchObject({
      status: 'REJECTED',
      failure_code: 'QUERY_TRANSPORT_CORRUPTED',
      provider_request_id: 'fixture-request',
    });
    expect(invalid.normalized_result).toMatchObject({
      intendedQuery: requirement.query,
      actualTransmittedQuery: corrupted,
      invalidationReason: 'QUERY_TRANSPORT_CORRUPTED',
    });
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(before);
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(evidenceCount);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('READY_FOR_REVIEW');
  });
});
