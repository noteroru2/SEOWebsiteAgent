import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  capabilityMismatch,
  classifyEvidenceRequirement,
  classifySerpIntent,
  compareOwnerSerpObservation,
  materialSerpObservationConflict,
  PROVIDER_CAPABILITIES,
  SerpApiProvider,
  SerpProviderError,
  SerperProvider,
  SerpstackProvider,
  selectProvider,
  serpEvidenceTrust,
  type NormalizedSerpResult,
  type SerpProvider,
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
  rejectSerpApiCaptureForContext,
  reserveSerpProviderAttempt,
  serpProviderStatus,
  storeOwnerEvidence,
} from '@seo-agent/database';
import { ResourceGuard } from '@seo-agent/resource-guard';
import { verifiedSerpFetchSchema } from '@seo-agent/shared';
import { executeOne } from '../apps/worker/src/runner';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const requirement = classifyEvidenceRequirement({
  query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
  requestedLocation: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
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
  it('rejects unknown browser device values at the server validation boundary', () => {
    expect(
      verifiedSerpFetchSchema.safeParse({
        locationProfileId: randomUUID(),
        device: 'SMART_TV',
      }).success,
    ).toBe(false);
  });
  it.each(['รับซื้อโน้ตบุ๊ค ใกล้ฉัน', 'ร้านใกล้เคียง', 'laptop near me', 'computer shop nearby'])(
    'classifies %s as hyperlocal without AI',
    (query) => {
      expect(classifySerpIntent({ query })).toBe('HYPERLOCAL');
      expect(classifyEvidenceRequirement({ query }).evidencePolicy).toBe(
        'HYPERLOCAL_SERP_REQUIRED',
      );
    },
  );
  it('classifies a normal query as non-hyperlocal and honors explicit metadata', () => {
    expect(classifySerpIntent({ query: 'รับซื้อ ram' })).toBe('NORMAL');
    expect(
      classifySerpIntent({
        query: 'รับซื้อ ram',
        metadata: { serpEvidenceRequirement: 'HYPERLOCAL_SERP_REQUIRED' },
      }),
    ).toBe('HYPERLOCAL');
    expect(
      classifySerpIntent({
        query: 'รับซื้อ ram',
        metadata: { HYPERLOCAL_SERP_REQUIRED: true },
      }),
    ).toBe('HYPERLOCAL');
  });
  it('ranks owner real-device evidence above API and emulation for hyperlocal intent', () => {
    expect(serpEvidenceTrust('HYPERLOCAL', 'OWNER_REAL_DEVICE')).toBe('PRIMARY_ELIGIBLE');
    expect(serpEvidenceTrust('HYPERLOCAL', 'OWNER_CONFIRMED_BROWSER_CAPTURE')).toBe(
      'PRIMARY_ELIGIBLE',
    );
    expect(serpEvidenceTrust('HYPERLOCAL', 'SERP_API_CITY')).toBe('SUPPORTING_ONLY');
    expect(serpEvidenceTrust('HYPERLOCAL', 'PLAYWRIGHT_EMULATED')).toBe('SUPPORTING_ONLY');
    expect(serpEvidenceTrust('NORMAL', 'SERP_API_CITY')).toBe('PRIMARY_ELIGIBLE');
  });
  it('bounds owner/API comparison by actual observed coverage', () => {
    expect(materialSerpObservationConflict(24, null, false, 8)).toBe(false);
    expect(compareOwnerSerpObservation(24, null, false, 8)).toMatchObject({
      comparison: 'COMPATIBLE_WITH_OWNER_OBSERVATION',
    });
    expect(materialSerpObservationConflict(2, null, false, 20)).toBe(true);
    expect(materialSerpObservationConflict(2, 3, true)).toBe(false);
  });
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
      search_metadata: { id: 'serpapi-id', status: 'Success' },
      search_parameters: {
        location_requested: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
        location_used: 'Ubon Ratchathani,Thailand',
      },
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
    expect(result.providerHttpStatus).toBe(200);
    expect(result.providerLatencyMs).toBeTypeOf('number');
    expect(result.requestedOrganicLimit).toBe(20);
    expect(result.actualOrganicCount).toBe(3);
    expect(result.maximumObservedOrganicPosition).toBe(3);
    expect(result.coverageStatus).toBe('PARTIAL');
    expect(result.paginationPerformed).toBe(false);
    expect(result.providerReportedPrecision).toBe('UNKNOWN');
    expect(result.requestedVerifiedPrecision).toBe(input.requiredPrecision);
    expect(result.effectiveEvidenceContext).toBe(`VERIFIED_${input.requiredPrecision}_REQUEST`);
    expect(result.providerLocationRequested).toBe(input.requestedLocation);
    if (name === 'SERPAPI') expect(result.providerSearchStatus).toBe('Success');
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    if (name === 'SERPAPI' || name === 'SERPSTACK')
      expect(new URL(requested!.url).searchParams.get('num')).toBe('20');
    else expect(JSON.parse(String(requested!.init?.body)).num).toBe(20);
  });

  it('models requested depth separately from returned coverage', async () => {
    const payload = providerResponse(name) as Record<string, unknown>;
    const organicKey = name === 'SERPER' ? 'organic' : 'organic_results';
    payload[organicKey] = Array.from({ length: 8 }, (_, index) => ({
      position: index + 1,
      title: `Result ${index + 1}`,
      snippet: null,
      link: `https://example${index + 1}.com/`,
      url: `https://example${index + 1}.com/`,
    }));
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    );
    const input =
      name === 'SERPER'
        ? { ...requirement, requiredPrecision: 'COUNTRY' as const, device: 'DESKTOP' as const }
        : requirement;
    const result = await adapter.search(input, AbortSignal.timeout(1_000));
    expect(result).toMatchObject({
      requestedOrganicLimit: 20,
      actualOrganicCount: 8,
      maximumObservedOrganicPosition: 8,
      paginationStart: 0,
      paginationPerformed: false,
      coverageStatus: 'PARTIAL',
      targetStatus: 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS',
      rankLowerBoundExclusive: 8,
      exactRankKnown: false,
    });
  });

  it('confirms requested depth only when all requested results are returned', async () => {
    const payload = providerResponse(name) as Record<string, unknown>;
    const organicKey = name === 'SERPER' ? 'organic' : 'organic_results';
    payload[organicKey] = Array.from({ length: 20 }, (_, index) => ({
      position: index + 1,
      title: `Result ${index + 1}`,
      snippet: null,
      link: `https://complete${index + 1}.example/`,
      url: `https://complete${index + 1}.example/`,
    }));
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    );
    const input =
      name === 'SERPER'
        ? { ...requirement, requiredPrecision: 'COUNTRY' as const, device: 'DESKTOP' as const }
        : requirement;
    const result = await adapter.search(input, AbortSignal.timeout(1_000));
    expect(result.coverageStatus).toBe('COMPLETE_THROUGH_20');
    expect(result.targetStatus).toBe('TARGET_NOT_FOUND_THROUGH_CONFIRMED_DEPTH');
    expect(result.rankLowerBoundExclusive).toBe(20);
  });

  it('keeps a returned target position exact even when coverage is partial', async () => {
    const payload = providerResponse(name) as Record<string, unknown>;
    const organicKey = name === 'SERPER' ? 'organic' : 'organic_results';
    payload[organicKey] = Array.from({ length: 8 }, (_, index) => ({
      position: index + 1,
      title: index === 4 ? 'AMPHON' : `Result ${index + 1}`,
      snippet: null,
      link: index === 4 ? 'https://amphon.co.th/ram' : `https://partial${index + 1}.example/`,
      url: index === 4 ? 'https://amphon.co.th/ram' : `https://partial${index + 1}.example/`,
    }));
    const adapter = new Adapter(
      'fixture-key',
      (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    );
    const input =
      name === 'SERPER'
        ? { ...requirement, requiredPrecision: 'COUNTRY' as const, device: 'DESKTOP' as const }
        : requirement;
    const result = await adapter.search(input, AbortSignal.timeout(1_000));
    expect(result).toMatchObject({
      coverageStatus: 'PARTIAL',
      targetStatus: 'TARGET_FOUND',
      targetOrganicPosition: 5,
      exactRankKnown: true,
      rankLowerBoundExclusive: null,
    });
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

  it('classifies a provider timeout as a network timeout', async () => {
    const adapter = new Adapter('fixture-key', (async () => {
      throw new DOMException('fixture timeout', 'AbortError');
    }) as typeof fetch);
    await expect(adapter.search(requirement, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      category: 'NETWORK_TIMEOUT',
      message: 'Provider request timed out',
      diagnostics: { origin: 'NETWORK' },
    });
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [500, 'TEMPORARILY_UNAVAILABLE'],
  ] as const)('keeps HTTP %s structurally distinct as %s', async (status, category) => {
    const adapter = new Adapter(
      'fixture-key',
      (async () =>
        new Response(JSON.stringify({ error: 'invalid location parameter' }), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    await expect(adapter.search(requirement, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      category,
      diagnostics: { origin: 'PROVIDER', httpStatus: status },
    });
  });
});

describe('SerpApi Unicode HTTP transport', () => {
  it.each([
    ['DESKTOP', 'desktop'],
    ['MOBILE', 'mobile'],
    ['TABLET', 'tablet'],
  ] as const)('maps internal %s to the provider %s device', async (device, providerDevice) => {
    let receivedDevice: string | null = null;
    const adapter = new SerpApiProvider('fixture-key', (async (input) => {
      const url = new URL(String(input));
      receivedDevice = url.searchParams.get('device');
      return new Response(
        JSON.stringify({
          search_metadata: { id: 'device-fixture', status: 'Success' },
          search_parameters: { location_used: requirement.requestedLocation },
          organic_results: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch);
    await adapter.search(
      { ...requirement, query: 'รับซื้อ ram', device },
      AbortSignal.timeout(1_000),
    );
    expect(receivedDevice).toBe(providerDevice);
  });
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
const workerGuard = new ResourceGuard(
  {},
  {
    collect: async () => ({
      freeMemoryMb: 2_000,
      freeDiskMb: 10_000,
      loadPerCpu: 0,
      platform: 'linux',
    }),
  },
);
let siteId = '';
let opportunityId = '';
let requestId = '';
let locationProfileId = '';

const normalizedFixture = (): NormalizedSerpResult => ({
  provider: 'SERPAPI',
  providerRequestId: 'owner-review-fixture',
  query: requirement.query,
  requestedLocation: requirement.requestedLocation,
  providerLocationRequested: requirement.requestedLocation,
  providerLocationUsed: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
  requestedVerifiedPrecision: 'CITY',
  providerReportedPrecision: 'UNKNOWN',
  effectiveEvidenceContext: 'VERIFIED_CITY_REQUEST',
  device: 'MOBILE',
  capturedAt: new Date().toISOString(),
  organicResults: [],
  requestedOrganicLimit: 20,
  actualOrganicCount: 0,
  maximumObservedOrganicPosition: 0,
  paginationStart: 0,
  paginationPerformed: false,
  coverageStatus: 'EMPTY',
  features: {
    ads: 'UNKNOWN',
    aiOverview: 'UNKNOWN',
    mapPack: 'UNKNOWN',
    peopleAlsoAsk: 'UNKNOWN',
    shopping: 'UNKNOWN',
  },
  targetFound: true,
  targetStatus: 'TARGET_FOUND',
  rankLowerBoundExclusive: null,
  exactRankKnown: true,
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

async function seedLocationProfile(
  overrides: Partial<{
    provider: 'SERPAPI' | 'SERPSTACK' | 'SERPER';
    canonicalLocation: string;
    providerLocationId: string;
    precision: 'CITY' | 'COUNTRY';
    status: 'ACTIVE' | 'INACTIVE';
  }> = {},
) {
  return (
    await database.pool.query(
      `INSERT INTO serp_location_profiles(site_id,owner_label,provider,canonical_location,
       provider_location_id,precision,country_code,timezone,verified_at,verification_source,status)
       VALUES($1,'Ubon Ratchathani, Thailand',$2,$3,$4,$5,'th','Asia/Bangkok',now(),
       'SERPAPI_LOCATIONS_API',$6) RETURNING id`,
      [
        siteId,
        overrides.provider ?? 'SERPAPI',
        overrides.canonicalLocation ?? 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
        overrides.providerLocationId ?? `fixture-${randomUUID()}`,
        overrides.precision ?? 'CITY',
        overrides.status ?? 'ACTIVE',
      ],
    )
  ).rows[0].id as string;
}

describe('transactional free quota and evidence integration', () => {
  const originalSerpApiKey = process.env.SERPAPI_API_KEY;
  beforeAll(async () => {
    process.env.SERPAPI_API_KEY = 'fixture-key';
    await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
  });
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    await seedProviderConfigs();
    siteId = (
      await createSite({ name: 'Provider Fixture', url: 'https://amphon.co.th/' }, database.db)
    ).id;
    locationProfileId = await seedLocationProfile({
      providerLocationId: '5b18bb955f59e41ee7212759',
    });
    ({ opportunityId, requestId } = await setupOpportunity());
  });
  afterAll(async () => {
    if (originalSerpApiKey === undefined) delete process.env.SERPAPI_API_KEY;
    else process.env.SERPAPI_API_KEY = originalSerpApiKey;
    await database.pool.end();
  });

  it('does not queue a call at zero allowance and returns owner-browser fallback', async () => {
    const outcome = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        locationProfileId,
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

  it('uses distinct capture and job identities for Desktop and Mobile', async () => {
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
    const desktop = await enqueueSerpApiCapture(
      { opportunityId, requestId, locationProfileId, device: 'DESKTOP' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const mobile = await enqueueSerpApiCapture(
      { opportunityId, requestId, locationProfileId, device: 'MOBILE' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(desktop.capture!.id).not.toBe(mobile.capture!.id);
    expect(desktop.capture!.request_fingerprint).not.toBe(mobile.capture!.request_fingerprint);
    const rows = await database.pool.query(
      `SELECT c.device,c.request_fingerprint,j.payload->>'device' job_device
       FROM serp_api_captures c JOIN jobs j ON j.id=c.job_id
       WHERE c.id=ANY($1::uuid[]) ORDER BY c.device`,
      [[desktop.capture!.id, mobile.capture!.id]],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ device: 'DESKTOP', job_device: 'DESKTOP' }),
      expect.objectContaining({ device: 'MOBILE', job_device: 'MOBILE' }),
    ]);
  });

  it.each(['DESKTOP', 'MOBILE', 'TABLET'] as const)(
    'preserves %s through job snapshot, worker requirement, and capture audit',
    async (device) => {
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
          locationProfileId,
          device,
          reviewPolicy: 'OWNER_REVIEW_REQUIRED',
        },
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
      );
      let workerDevice: string | null = null;
      const provider: SerpProvider = {
        name: 'SERPAPI',
        capabilities: PROVIDER_CAPABILITIES.SERPAPI,
        search: async (workerRequirement) => {
          workerDevice = workerRequirement.device;
          return { ...normalizedFixture(), device };
        },
      };
      const outcome = await executeOne(
        `device-${device.toLowerCase()}-worker`,
        database.pool,
        workerGuard,
        undefined,
        undefined,
        undefined,
        () => provider,
      );
      expect(outcome.state).toBe('SUCCEEDED');
      expect(workerDevice).toBe(device);
      expect(
        (
          await database.pool.query(
            `SELECT c.device,c.normalized_result->>'device' result_device,j.payload->>'device' job_device
             FROM serp_api_captures c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1`,
            [queued.capture!.id],
          )
        ).rows[0],
      ).toMatchObject({ device, result_device: device, job_device: device });
    },
  );

  it('marks a job successful only when a normalized provider capture is produced', async () => {
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
        locationProfileId,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const provider: SerpProvider = {
      name: 'SERPAPI',
      capabilities: PROVIDER_CAPABILITIES.SERPAPI,
      search: async () => normalizedFixture(),
    };
    const outcome = await executeOne(
      'serp-success-worker',
      database.pool,
      workerGuard,
      undefined,
      undefined,
      undefined,
      () => provider,
    );
    expect(outcome.state).toBe('SUCCEEDED');
    expect(
      (await database.pool.query(`SELECT status FROM jobs WHERE id=$1`, [queued.capture!.job_id]))
        .rows[0].status,
    ).toBe('SUCCEEDED');
    expect(
      (
        await database.pool.query(
          `SELECT status,normalized_result FROM serp_api_captures WHERE id=$1`,
          [queued.capture!.id],
        )
      ).rows[0],
    ).toMatchObject({ status: 'PENDING_REVIEW', normalized_result: { provider: 'SERPAPI' } });
  });

  it('retains a temporary provider failure, requires owner action, and never retries or creates evidence', async () => {
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
      `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/failure-semantics-fixture') RETURNING id`,
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
    const packetBefore = await deterministicEvidencePacket(opportunityId, database.pool);
    const queued = await enqueueSerpApiCapture(
      {
        opportunityId,
        requestId,
        locationProfileId,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const selectedProviders: string[] = [];
    let calls = 0;
    const providerFactory = (name: 'SERPAPI' | 'SERPSTACK' | 'SERPER'): SerpProvider => {
      selectedProviders.push(name);
      return {
        name,
        capabilities: PROVIDER_CAPABILITIES[name],
        search: async () => {
          calls += 1;
          throw new SerpProviderError(
            'TEMPORARILY_UNAVAILABLE',
            'Provider temporarily unavailable',
            false,
            {
              origin: 'PROVIDER',
              httpStatus: 503,
              responseContentType: 'application/json',
              providerRequestId: 'fixture-request-id',
              providerStatus: 'Error',
            },
          );
        },
      };
    };
    const outcome = await executeOne(
      'serp-failure-worker',
      database.pool,
      workerGuard,
      undefined,
      undefined,
      undefined,
      providerFactory,
    );
    expect(outcome.state).toBe('FAILED');
    expect(calls).toBe(1);
    expect(selectedProviders).toEqual(['SERPAPI']);
    expect(
      (
        await database.pool.query(
          `SELECT status,result,failure_code,failure_summary FROM jobs WHERE id=$1`,
          [queued.capture!.job_id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'FAILED',
      result: null,
      failure_code: 'SERP_OWNER_ACTION_REQUIRED',
    });
    const capture = (
      await database.pool.query(
        `SELECT status,failure_code,failure_origin,failure_http_status,failure_content_type,
          provider_request_id,failure_provider_status,failure_history,normalized_result
         FROM serp_api_captures WHERE id=$1`,
        [queued.capture!.id],
      )
    ).rows[0];
    expect(capture).toMatchObject({
      status: 'FAILED',
      failure_code: 'TEMPORARILY_UNAVAILABLE',
      failure_origin: 'PROVIDER',
      failure_http_status: 503,
      failure_content_type: 'application/json',
      provider_request_id: 'fixture-request-id',
      failure_provider_status: 'Error',
      normalized_result: null,
    });
    expect(capture.failure_history).toHaveLength(1);
    expect(capture.failure_history[0]).toMatchObject({
      category: 'TEMPORARILY_UNAVAILABLE',
      origin: 'PROVIDER',
      httpStatus: 503,
    });
    expect(
      (
        await database.pool.query(
          `SELECT event FROM job_events WHERE job_id=$1 ORDER BY created_at,id`,
          [queued.capture!.job_id],
        )
      ).rows.map((row) => row.event),
    ).toEqual([
      'ENQUEUED',
      'CLAIMED',
      'SERP_API_FETCH_STARTED',
      'SERP_API_PROVIDER_FAILED',
      'SERP_API_FALLBACK_REQUIRED',
      'FAILED',
    ]);
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM evidence_items WHERE request_id=$1`,
          [requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(packetBefore);
    expect(
      (
        await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [
          plan.rows[0].id,
        ])
      ).rows[0].status,
    ).toBe('READY_FOR_REVIEW');
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
    expect(
      (
        await serpProviderStatus({ SERPAPI: true, SERPSTACK: false, SERPER: false }, database.pool)
      ).find((entry) => entry.provider === 'SERPAPI'),
    ).toMatchObject({
      health: 'TEMPORARILY_UNAVAILABLE',
      last_error_category: 'TEMPORARILY_UNAVAILABLE',
      consecutive_failures: 1,
      selection_eligible: false,
      used: 1,
      reserved: 0,
    });
  });

  it('keeps capability mismatch distinct without invoking a provider', async () => {
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
      { opportunityId, requestId, locationProfileId, device: 'MOBILE' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await database.pool.query(
      `UPDATE serp_provider_configs
       SET capabilities=jsonb_set(capabilities,'{supportsMobile}','false'::jsonb)
       WHERE provider='SERPAPI'`,
    );
    expect(
      await reserveSerpProviderAttempt(
        queued.capture!.id,
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
      ),
    ).toBeNull();
    expect(
      (
        await database.pool.query(
          `SELECT status,failure_code,failure_summary FROM serp_api_captures WHERE id=$1`,
          [queued.capture!.id],
        )
      ).rows[0],
    ).toMatchObject({ status: 'CAPABILITY_MISMATCH', failure_code: 'CAPABILITY_MISMATCH' });
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
        locationProfileId,
        device: 'MOBILE',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const secondIdentity = await setupOpportunity('provider-pool-second');
    const second = await enqueueSerpApiCapture(
      { ...secondIdentity, locationProfileId, device: 'MOBILE' },
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
        locationProfileId,
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
      locationProfileId,
      requestedLocationLabel: 'Ubon Ratchathani, Thailand',
      provider: 'SERPAPI',
      canonicalProviderLocation: 'Ubon Ratchathani,Ubon Ratchathani,Thailand',
      providerLocationId: '5b18bb955f59e41ee7212759',
      verifiedPrecision: 'CITY',
      countryCode: 'th',
      timezone: 'Asia/Bangkok',
    });
    expect(JSON.stringify(persisted.rows[0].job_payload)).not.toContain('?');
    const attempt = await reserveSerpProviderAttempt(
      queued.capture!.id,
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(attempt?.requirement.query).toBe(expected);
    expect(attempt?.requirement.requestedLocation).toBe(
      'Ubon Ratchathani,Ubon Ratchathani,Thailand',
    );
  });

  it.each([
    [{ precision: 'COUNTRY' as const }, 'SERP_LOCATION_PRECISION_DOWNGRADE'],
    [{ status: 'INACTIVE' as const }, 'SERP_LOCATION_PROFILE_INACTIVE'],
    [{ provider: 'SERPSTACK' as const }, 'SERP_LOCATION_PROVIDER_MISMATCH'],
  ])(
    'blocks an unsafe verified-location profile before capture or quota reservation',
    async (overrides, code) => {
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
      const unsafeProfileId = await seedLocationProfile(overrides);
      await expect(
        enqueueSerpApiCapture(
          { opportunityId, requestId, locationProfileId: unsafeProfileId, device: 'MOBILE' },
          { SERPAPI: true, SERPSTACK: true, SERPER: false },
          database.pool,
        ),
      ).rejects.toThrow(code);
      expect(
        (await database.pool.query(`SELECT count(*)::int n FROM serp_api_captures`)).rows[0].n,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            `SELECT used,reserved FROM serp_provider_usage_periods WHERE provider='SERPAPI'`,
          )
        ).rows[0],
      ).toMatchObject({ used: 0, reserved: 0 });
    },
  );

  it('includes verified provider location identity in request fingerprint', async () => {
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
    const first = await enqueueSerpApiCapture(
      { opportunityId, requestId, locationProfileId, device: 'MOBILE' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    await database.pool.query(`UPDATE jobs SET status='CANCELLED' WHERE id=$1`, [
      first.capture!.job_id,
    ]);
    await database.pool.query(`UPDATE serp_api_captures SET status='REJECTED' WHERE id=$1`, [
      first.capture!.id,
    ]);
    const alternateProfileId = await seedLocationProfile({
      providerLocationId: 'alternate-location-id',
    });
    const second = await enqueueSerpApiCapture(
      { opportunityId, requestId, locationProfileId: alternateProfileId, device: 'MOBILE' },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    expect(second.capture!.request_fingerprint).not.toBe(first.capture!.request_fingerprint);
  });

  it('blocks a tampered job location snapshot before quota reservation', async () => {
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
        locationProfileId,
        device: 'MOBILE',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const payload = (
      await database.pool.query(`SELECT payload FROM jobs WHERE id=$1`, [queued.capture!.job_id])
    ).rows[0].payload;
    await expect(
      reserveSerpProviderAttempt(
        queued.capture!.id,
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
        { ...payload, canonicalProviderLocation: 'Bangkok,Thailand' },
      ),
    ).rejects.toThrow('SERP_LOCATION_JOB_IDENTITY_MISMATCH');
    const period = (
      await database.pool.query(
        `SELECT used,reserved FROM serp_provider_usage_periods WHERE provider='SERPAPI'`,
      )
    ).rows[0];
    expect(period).toMatchObject({ used: 0, reserved: 0 });
  });

  it('blocks a tampered device snapshot before quota reservation or provider execution', async () => {
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
        locationProfileId,
        device: 'DESKTOP',
        reviewPolicy: 'OWNER_REVIEW_REQUIRED',
      },
      { SERPAPI: true, SERPSTACK: false, SERPER: false },
      database.pool,
    );
    const payload = (
      await database.pool.query(`SELECT payload FROM jobs WHERE id=$1`, [queued.capture!.job_id])
    ).rows[0].payload;
    await expect(
      reserveSerpProviderAttempt(
        queued.capture!.id,
        { SERPAPI: true, SERPSTACK: false, SERPER: false },
        database.pool,
        { ...payload, device: 'MOBILE' },
      ),
    ).rejects.toThrow('SERP_DEVICE_JOB_IDENTITY_MISMATCH');
    expect(
      (
        await database.pool.query(
          `SELECT used,reserved FROM serp_provider_usage_periods WHERE provider='SERPAPI'`,
        )
      ).rows[0],
    ).toMatchObject({ used: 0, reserved: 0 });
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
        locationProfileId,
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
        locationProfileId,
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
    await database.pool.query(`UPDATE opportunities SET query='รับซื้อ ram' WHERE id=$1`, [
      opportunityId,
    ]);
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
        locationProfileId,
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
      await persistSerpApiSuccess(
        queued.capture!.id,
        { ...normalizedFixture(), query: 'รับซื้อ ram' },
        database.pool,
      ),
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
        locationProfileId,
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
    await database.pool.query(`UPDATE opportunities SET query='รับซื้อ ram' WHERE id=$1`, [
      opportunityId,
    ]);
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
        locationProfileId,
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
      ...normalizedFixture(),
      provider: 'SERPAPI',
      providerRequestId: 'fixture',
      query: 'รับซื้อ ram',
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon Ratchathani,Thailand',
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
    expect(item.evidence.evidenceQuality).toBe('SERP_API_VERIFIED_CITY_REQUEST');
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
        locationProfileId,
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
      `UPDATE opportunities SET kind='QUERY_PAGE_OVERLAP_CANDIDATE',query='รับซื้อ ram' WHERE id=$1`,
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
        locationProfileId,
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
      ...normalizedFixture(),
      provider: 'SERPAPI',
      providerRequestId: null,
      query: 'รับซื้อ ram',
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon',
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

  it('keeps a partial normal-query capture pending and compatible when owner rank is beyond observed depth', async () => {
    await database.pool.query(`UPDATE opportunities SET query='รับซื้อ ram' WHERE id=$1`, [
      opportunityId,
    ]);
    await storeOwnerEvidence(
      {
        requestId,
        sourceType: 'OWNER_OBSERVED_SERP',
        evidence: {
          query: 'รับซื้อ ram',
          location: 'Ubon',
          device: 'Desktop',
          displayedTitle: 'Owner',
          displayedSnippet: 'Owner',
          rankingUrl: 'https://amphon.co.th/บริการ/รับซื้อแรม',
          approximatePosition: 24,
          serpFeatures: [],
        },
        observedAt: new Date(),
        observedTimezone: 'Asia/Bangkok',
      },
      database.pool,
    );
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
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
        locationProfileId,
        device: 'DESKTOP',
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
    const partial = {
      ...normalizedFixture(),
      query: 'รับซื้อ ram',
      device: 'DESKTOP' as const,
      organicResults: Array.from({ length: 8 }, (_, index) => ({
        position: index + 1,
        title: `Other ${index + 1}`,
        snippet: null,
        url: `https://other${index + 1}.example/`,
        displayedUrl: null,
      })),
      requestedOrganicLimit: 20,
      actualOrganicCount: 8,
      maximumObservedOrganicPosition: 8,
      coverageStatus: 'PARTIAL' as const,
      targetFound: false,
      targetStatus: 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS' as const,
      rankLowerBoundExclusive: 8,
      exactRankKnown: false,
      targetOrganicPosition: null,
      targetUrl: null,
      targetTitle: null,
      targetSnippet: null,
    } satisfies NormalizedSerpResult;
    expect(await persistSerpApiSuccess(queued.capture!.id, partial, database.pool)).toEqual({
      accepted: false,
      pendingReview: true,
      conflict: false,
    });
    expect(
      (
        await database.pool.query(
          `SELECT status,coverage_status,target_status,rank_lower_bound_exclusive,conflict,
           owner_comparison,verified_precision,provider_reported_precision,effective_evidence_context
           FROM serp_api_captures WHERE id=$1`,
          [queued.capture!.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'PENDING_REVIEW',
      coverage_status: 'PARTIAL',
      target_status: 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS',
      rank_lower_bound_exclusive: 8,
      conflict: false,
      owner_comparison: 'COMPATIBLE_WITH_OWNER_OBSERVATION',
      verified_precision: 'CITY',
      provider_reported_precision: 'UNKNOWN',
      effective_evidence_context: 'VERIFIED_CITY_REQUEST',
    });
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(before);
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
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
    expect(
      (await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [requestId]))
        .rows[0].status,
    ).toBe('RESOLVED');
    const ownerPacket = await deterministicEvidencePacket(opportunityId, database.pool);
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
        locationProfileId,
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
      ...normalizedFixture(),
      provider: 'SERPAPI',
      providerRequestId: null,
      query: requirement.query,
      requestedLocation: requirement.requestedLocation,
      providerLocationUsed: 'Ubon',
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
      targetFound: false,
      targetStatus: 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS',
      rankLowerBoundExclusive: 8,
      exactRankKnown: false,
      actualOrganicCount: 8,
      maximumObservedOrganicPosition: 8,
      coverageStatus: 'PARTIAL',
      targetOrganicPosition: null,
      targetUrl: null,
      targetTitle: null,
      targetSnippet: null,
    } satisfies NormalizedSerpResult;
    const outcome = await persistSerpApiSuccess(queued.capture!.id, api, database.pool);
    expect(outcome).toMatchObject({ conflict: true, accepted: false, pendingReview: true });
    const rows = await database.pool.query(
      `SELECT source_type FROM evidence_items WHERE request_id=$1 ORDER BY created_at`,
      [requestId],
    );
    expect(rows.rows.map((row) => row.source_type)).toEqual(['OWNER_OBSERVED_SERP']);
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(ownerPacket);
    const pending = (
      await database.pool.query(
        `SELECT status,intent_class,trust_role,conflict,conflict_detail,normalized_result,
         provider_request_id FROM serp_api_captures WHERE id=$1`,
        [queued.capture!.id],
      )
    ).rows[0];
    expect(pending).toMatchObject({
      status: 'PENDING_REVIEW',
      intent_class: 'HYPERLOCAL',
      trust_role: 'SUPPORTING_ONLY',
      conflict: true,
      conflict_detail: {
        type: 'SERP_OBSERVATION_CONFLICT',
        ownerPositions: [5],
        providerTargetState: 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS_OBSERVED_MAX_8',
      },
    });
    expect(pending.normalized_result.features).toEqual(api.features);
    await expect(acceptSerpApiCapture(queued.capture!.id, database.pool)).rejects.toThrow(
      'supporting evidence only',
    );
    const rejected = await rejectSerpApiCaptureForContext(
      queued.capture!.id,
      'HYPERLOCAL_CONTEXT_DISAGREEMENT',
      database.pool,
    );
    expect(rejected).toMatchObject({
      status: 'REJECTED_FOR_TARGET_CONTEXT',
      rejection_reason: 'HYPERLOCAL_CONTEXT_DISAGREEMENT',
      normalized_result: { features: api.features },
    });
    expect(await deterministicEvidencePacket(opportunityId, database.pool)).toEqual(ownerPacket);
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM jobs WHERE type IN ('AI_SOURCE_PLAN','EVIDENCE_REEVALUATION')`,
        )
      ).rows[0].n,
    ).toBe(0);
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
