import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  autoResolveOwnerBusinessConfirmation,
  classifyOwnerFactCandidates,
  confirmReusableOwnerFact,
  confirmSerpCapture,
  createBrowserCaptureToken,
  createDatabase,
  createSite,
  deterministicEvidencePacket,
  enqueueSerpCapture,
  ingestOwnerAssistedCapture,
  ensureEvidenceRequest,
  ownerFactStateForOpportunity,
  persistSerpCaptureSuccess,
  requiredOwnerFacts,
} from '@seo-agent/database';
import {
  extractGoogleSerp,
  assistedCapturePayloadSchema,
  assistedCapturePayloadWithinBounds,
  ASSISTED_CAPTURE_MAX_BYTES,
  ASSISTED_CAPTURE_VERSION,
  createOwnerAssistedBookmarklet,
  isAllowedGoogleOrigin,
  POSITION_EXTRACTION_VERSION,
  resolveGoogleHref,
  SERP_PARSER_VERSION,
} from '@seo-agent/serp-capture';
import type { AssistedCapturePayload } from '@seo-agent/serp-capture';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';
import {
  OPTIONS as assistedCaptureOptions,
  POST as assistedCapturePost,
} from '../apps/web/app/api/browser-captures/ingest/route';

const result = (
  href = 'https://amphon.co.th/target',
  title = 'รับซื้อโน๊ตบุ๊ค อุบลราชธานี',
  snippet = 'ส่งรูปประเมินราคาได้',
) =>
  `<div data-organic-result><a href="${href}"><h3>${title}</h3></a><div data-snippet>${snippet}</div></div>`;
const page = (...parts: string[]) => `<html><body>${parts.join('')}</body></html>`;

describe('deterministic Google SERP parser v1', () => {
  it('extracts a normal Thai target result at position one', () => {
    const parsed = extractGoogleSerp(page(result()), 'amphon.co.th');
    expect(parsed).toMatchObject({
      displayedTitle: 'รับซื้อโน๊ตบุ๊ค อุบลราชธานี',
      displayedSnippet: 'ส่งรูปประเมินราคาได้',
      resolvedLandingUrl: 'https://amphon.co.th/target',
      approximateOrganicPosition: 1,
      parserVersion: SERP_PARSER_VERSION,
      positionExtractionVersion: POSITION_EXTRACTION_VERSION,
    });
  });
  it('extracts the target at organic position two', () => {
    const parsed = extractGoogleSerp(
      page(result('https://example.com/'), result()),
      'amphon.co.th',
    );
    expect(parsed.approximateOrganicPosition).toBe(2);
  });
  it.each([
    ['ads', 'ADS'],
    ['ai-overview', 'AI_OVERVIEW'],
    ['map-pack', 'MAP_PACK'],
    ['paa', 'PEOPLE_ALSO_ASK'],
    ['shopping', 'SHOPPING_OR_PRODUCT_RESULTS'],
  ] as const)('detects %s without counting it as organic', (fixture, feature) => {
    const parsed = extractGoogleSerp(
      page(`<section data-serp-feature="${fixture}">module</section>`, result()),
      'amphon.co.th',
    );
    expect(parsed.features[feature]).toBe('PRESENT');
    expect(parsed.approximateOrganicPosition).toBe(1);
  });
  it('decodes Google redirect URLs to the actual Thai landing URL', () => {
    const target = 'https://amphon.co.th/รับซื้อ/รับซื้อโน๊ตบุ๊ค-อุบลราชธานี';
    const href = `/url?q=${encodeURIComponent(target)}&sa=U`;
    expect(resolveGoogleHref(href)).toBe(new URL(target).toString());
    expect(extractGoogleSerp(page(result(href)), 'amphon.co.th').resolvedLandingUrl).toBe(
      new URL(target).toString(),
    );
  });
  it('returns null target fields when the target domain is absent', () => {
    expect(extractGoogleSerp(page(result('https://example.com/')), 'amphon.co.th')).toMatchObject({
      resolvedLandingUrl: null,
      approximateOrganicPosition: null,
    });
  });
  it('fails safely on CAPTCHA pages', () => {
    expect(
      extractGoogleSerp(page('<form id="captcha-form">unusual traffic</form>'), 'amphon.co.th'),
    ).toMatchObject({
      blocked: true,
      blockedReason: 'Google returned a CAPTCHA or unusual-traffic challenge',
    });
  });
  it('flags partially unknown DOM and never reports unrecognized features absent', () => {
    const parsed = extractGoogleSerp(
      page('<div class="tF2Cxc"><a href="https://amphon.co.th/"><h3>AMPHON</h3></a></div>'),
      'amphon.co.th',
    );
    expect(parsed.lowConfidenceFields).toContain('displayedSnippet');
    expect(parsed.lowConfidenceFields).toContain('domStructure');
    expect(Object.values(parsed.features).every((value) => value === 'UNKNOWN')).toBe(true);
  });

  it('accepts only explicit Google HTTPS origins for assisted ingestion', () => {
    expect(isAllowedGoogleOrigin('https://www.google.com')).toBe(true);
    expect(isAllowedGoogleOrigin('https://www.google.co.th')).toBe(true);
    expect(isAllowedGoogleOrigin('http://www.google.com')).toBe(false);
    expect(isAllowedGoogleOrigin('https://google.com.example.test')).toBe(false);
    expect(isAllowedGoogleOrigin(null)).toBe(false);
  });

  it('generates a fixed local collector without cookie or browser storage collection', () => {
    const bookmarklet = createOwnerAssistedBookmarklet({
      endpoint: 'http://localhost:3000/api/browser-captures/ingest',
      token: 't'.repeat(43),
      opportunityId: '00000000-0000-4000-8000-000000000001',
      expectedQuery: 'notebook query',
      targetDomain: 'amphon.co.th',
    });
    expect(bookmarklet.startsWith('javascript:')).toBe(true);
    expect(() => new Function(bookmarklet.slice('javascript:'.length))).not.toThrow();
    expect(bookmarklet).toContain('amphon.co.th');
    expect(bookmarklet).not.toContain('document.cookie');
    expect(bookmarklet).not.toContain('localStorage');
    expect(bookmarklet).not.toContain('sessionStorage');
  });

  it('rejects malformed and oversized assisted payloads', () => {
    expect(assistedCapturePayloadSchema.safeParse({ token: 'x' }).success).toBe(false);
    expect(assistedCapturePayloadWithinBounds('x'.repeat(ASSISTED_CAPTURE_MAX_BYTES))).toBe(true);
    expect(assistedCapturePayloadWithinBounds('x'.repeat(ASSISTED_CAPTURE_MAX_BYTES + 1))).toBe(
      false,
    );
  });

  it('enforces CORS and payload bounds at the assisted ingestion endpoint', async () => {
    const allowed = await assistedCaptureOptions(
      new Request('http://localhost:3000/api/browser-captures/ingest', {
        method: 'OPTIONS',
        headers: { Origin: 'https://www.google.co.th' },
      }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://www.google.co.th');
    const denied = await assistedCaptureOptions(
      new Request('http://localhost:3000/api/browser-captures/ingest', {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      }),
    );
    expect(denied.status).toBe(403);
    const oversized = await assistedCapturePost(
      new Request('http://localhost:3000/api/browser-captures/ingest', {
        method: 'POST',
        headers: { Origin: 'https://www.google.com' },
        body: 'x'.repeat(ASSISTED_CAPTURE_MAX_BYTES + 1),
      }),
    );
    expect(oversized.status).toBe(413);
    const malformed = await assistedCapturePost(
      new Request('http://localhost:3000/api/browser-captures/ingest', {
        method: 'POST',
        headers: { Origin: 'https://www.google.com' },
        body: JSON.stringify({ token: 'x' }),
      }),
    );
    expect(malformed.status).toBe(400);
  });
});

describe('owner fact matching rules', () => {
  const requirement = requiredOwnerFacts({ query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน' })[0]!;
  const fact = (overrides: Record<string, unknown> = {}) => ({
    fact_key: requirement.factKey,
    scope_type: requirement.scopeType,
    scope_key: requirement.scopeKey,
    status: 'ACTIVE',
    value_json: true,
    review_after: new Date(Date.now() + 86_400_000),
    source_evidence_item_id: 'owner-source',
    ...overrides,
  });
  it('matches one exact active scoped owner fact', () =>
    expect(classifyOwnerFactCandidates(requirement, [fact()]).match).toBeTruthy());
  it('does not match a missing fact', () =>
    expect(classifyOwnerFactCandidates(requirement, []).match).toBeNull());
  it('does not match an expired fact', () =>
    expect(
      classifyOwnerFactCandidates(requirement, [fact({ review_after: new Date(0) })]).expired,
    ).toBe(true));
  it('does not match conflicting active facts', () =>
    expect(
      classifyOwnerFactCandidates(requirement, [fact(), fact({ value_json: false })]).conflict,
    ).toBe(true));
  it('does not reuse the wrong service scope', () =>
    expect(
      classifyOwnerFactCandidates(requirement, [fact({ scope_key: 'ram' })]).match,
    ).toBeNull());
  it('does not reuse the wrong geography', () =>
    expect(
      classifyOwnerFactCandidates(
        { ...requirement, scopeType: 'GEOGRAPHY', scopeKey: 'ubon-ratchathani' },
        [fact({ scope_type: 'GEOGRAPHY', scope_key: 'bangkok' })],
      ).match,
    ).toBeNull());
  it('reuses a business-wide fact only for an explicit business-wide requirement', () =>
    expect(
      classifyOwnerFactCandidates({ ...requirement, scopeType: 'BUSINESS_WIDE', scopeKey: '*' }, [
        fact({ scope_type: 'BUSINESS_WIDE', scope_key: '*' }),
      ]).match,
    ).toBeTruthy());
  it('does not broaden a query fact', () =>
    expect(
      classifyOwnerFactCandidates(requirement, [
        fact({ scope_type: 'QUERY', scope_key: 'one query' }),
      ]).match,
    ).toBeNull());
  it('does not reuse a superseded fact', () =>
    expect(
      classifyOwnerFactCandidates(requirement, [fact({ status: 'SUPERSEDED' })]).match,
    ).toBeNull());
});

const database = createDatabase(requireTestDatabaseUrl());
let siteId = '';
let opportunityId = '';
let businessRequestId = '';
let serpRequestId = '';

describe('evidence automation database workflow', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    const site = await createSite(
      { name: 'Automation Fixture', url: 'https://amphon.co.th/' },
      database.db,
    );
    siteId = site.id;
    opportunityId = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
       VALUES($1,'LOW_CTR_QUERY','รับซื้อโน๊ตบุ๊ค ใกล้ฉัน','Fixture','Evidence','automation-fixture','OPEN') RETURNING id`,
        [siteId],
      )
    ).rows[0].id;
    businessRequestId = (
      await ensureEvidenceRequest(
        {
          opportunityId,
          type: 'OWNER_BUSINESS_CONFIRMATION',
          requirement: 'Required structured facts',
          reason: 'test',
          source: 'OWNER',
        },
        database.pool,
      )
    ).id;
    serpRequestId = (
      await ensureEvidenceRequest(
        {
          opportunityId,
          type: 'MANUAL_SERP_OBSERVATION',
          requirement: 'Observed result',
          reason: 'test',
          source: 'OWNER',
        },
        database.pool,
      )
    ).id;
  });
  afterAll(async () => database.pool.end());

  it('populates the registry, retains direct provenance, auto-resolves only when complete, and changes packet identity with zero AI usage', async () => {
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const requirements = requiredOwnerFacts({ query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน' });
    for (const [index, requirement] of requirements.entries()) {
      const outcome = await confirmReusableOwnerFact(
        { opportunityId, requestId: businessRequestId, factKey: requirement.factKey },
        database.pool,
      );
      expect(outcome.resolved).toBe(index === requirements.length - 1);
    }
    const state = await ownerFactStateForOpportunity(opportunityId, database.pool);
    expect(state.complete).toBe(true);
    const rows = await database.pool.query(
      `SELECT source_evidence_item_id,fact_hash FROM owner_facts`,
    );
    expect(rows.rows).toHaveLength(requirements.length);
    expect(
      rows.rows.every((row) => row.source_evidence_item_id && /^[a-f0-9]{64}$/.test(row.fact_hash)),
    ).toBe(true);
    const finalItem = (
      await database.pool.query(
        `SELECT source_type,evidence FROM evidence_items WHERE request_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [businessRequestId],
      )
    ).rows[0];
    expect(finalItem.source_type).toBe('OWNER_CONFIRMED_REUSED');
    expect(
      finalItem.evidence.facts.every(
        (entry: Record<string, unknown>) => entry.originalEvidenceItemId,
      ),
    ).toBe(true);
    const after = await deterministicEvidencePacket(opportunityId, database.pool);
    expect(after.evidencePacketHash).not.toBe(before.evidencePacketHash);
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
  });

  it('deduplicates simultaneous capture requests in the PostgreSQL queue', async () => {
    const input = {
      opportunityId,
      requestId: serpRequestId,
      deviceProvenance: 'EMULATED_DESKTOP' as const,
      requestedLocationLabel: 'Ubon Ratchathani',
      timezone: 'Asia/Bangkok',
    };
    const [a, b] = await Promise.all([
      enqueueSerpCapture(input, database.pool),
      enqueueSerpCapture(input, database.pool),
    ]);
    expect(a.id).toBe(b.id);
    expect([a, b].filter((item) => item.deduplicated)).toHaveLength(1);
    expect(
      (await database.pool.query(`SELECT count(*)::int n FROM jobs WHERE type='CAPTURE_SERP'`))
        .rows[0].n,
    ).toBe(1);
  });

  it('auto-resolves a future exact-scope request from reusable owner facts', async () => {
    for (const requirement of requiredOwnerFacts({ query: 'รับซื้อโน๊ตบุ๊ค ใกล้ฉัน' }))
      await confirmReusableOwnerFact(
        { opportunityId, requestId: businessRequestId, factKey: requirement.factKey },
        database.pool,
      );
    const futureId = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
         VALUES($1,'LOW_CTR_QUERY','รับซื้อโน๊ตบุ๊ค ใกล้ฉัน','Future','Evidence','automation-future','OPEN') RETURNING id`,
        [siteId],
      )
    ).rows[0].id;
    const request = await ensureEvidenceRequest(
      {
        opportunityId: futureId,
        type: 'OWNER_BUSINESS_CONFIRMATION',
        requirement: 'Required structured facts',
        reason: 'test',
        source: 'OWNER',
      },
      database.pool,
    );
    expect((await autoResolveOwnerBusinessConfirmation(futureId, database.pool)).resolved).toBe(
      true,
    );
    const reused = await database.pool.query(
      `SELECT source_type,evidence FROM evidence_items WHERE request_id=$1`,
      [request.id],
    );
    expect(reused.rows[0].source_type).toBe('OWNER_CONFIRMED_REUSED');
    expect(reused.rows[0].evidence.facts).toHaveLength(6);
  });

  it('requires owner confirmation, retains corrections, resolves evidence, and never enqueues AI', async () => {
    const capture = await enqueueSerpCapture(
      {
        opportunityId,
        requestId: serpRequestId,
        deviceProvenance: 'EMULATED_MOBILE',
        requestedLocationLabel: 'Ubon Ratchathani',
        timezone: 'Asia/Bangkok',
      },
      database.pool,
    );
    await database.pool.query(`UPDATE jobs SET status='RUNNING' WHERE id=$1`, [capture.job_id]);
    await database.pool.query(`UPDATE serp_captures SET status='CAPTURING' WHERE id=$1`, [
      capture.id,
    ]);
    await persistSerpCaptureSuccess(
      capture.id,
      {
        extraction: {
          displayedTitle: 'Machine title',
          displayedSnippet: 'Machine snippet',
          resolvedLandingUrl: 'https://amphon.co.th/machine',
          approximateOrganicPosition: 2,
          features: { ADS: 'UNKNOWN' },
          parserVersion: SERP_PARSER_VERSION,
          positionExtractionVersion: POSITION_EXTRACTION_VERSION,
          blocked: false,
        },
        screenshotPath: '/app/artifacts/serp/test.png',
        screenshotSha256: 'a'.repeat(64),
        googleDisplayedLocation: null,
        capturedAt: new Date('2026-08-12T08:00:00Z'),
      },
      database.pool,
    );
    expect(
      (
        await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [
          serpRequestId,
        ])
      ).rows[0].status,
    ).toBe('OPEN');
    const confirmed = await confirmSerpCapture(
      {
        opportunityId,
        captureId: capture.id,
        displayedTitle: 'Owner corrected title',
        displayedSnippet: 'Machine snippet',
        rankingUrl: 'https://amphon.co.th/corrected',
        approximateOrganicPosition: 2,
        serpFeatures: [],
      },
      database.pool,
    );
    expect(confirmed.corrected).toBe(true);
    const stored = (
      await database.pool.query(
        `SELECT corrected,machine_capture,owner_confirmed_value,status FROM serp_captures WHERE id=$1`,
        [capture.id],
      )
    ).rows[0];
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.machine_capture.displayedTitle).toBe('Machine title');
    expect(stored.owner_confirmed_value.displayedTitle).toBe('Owner corrected title');
    expect(
      (
        await database.pool.query(`SELECT status FROM evidence_requests WHERE id=$1`, [
          serpRequestId,
        ])
      ).rows[0].status,
    ).toBe('RESOLVED');
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::int n FROM jobs WHERE type='GENERATE_SOURCE_CHANGE_PLAN'`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
  });

  it('authenticates a one-time assisted capture, fixes its identity, and accepts target-missing UNKNOWN data', async () => {
    const before = await deterministicEvidencePacket(opportunityId, database.pool);
    const grant = await createBrowserCaptureToken(
      {
        opportunityId,
        requestId: serpRequestId,
        ownerDeclaredLocation: 'Ubon Ratchathani, Thailand',
      },
      database.pool,
    );
    const payload: AssistedCapturePayload = {
      token: grant.token,
      opportunityId,
      query: grant.expectedQuery,
      capturedAt: new Date().toISOString(),
      timezone: 'Asia/Bangkok',
      userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      googleDisplayedLocation: null,
      displayedTitle: null,
      displayedSnippet: null,
      rawHref: null,
      resolvedLandingUrl: null,
      approximateOrganicPosition: null,
      features: {
        ADS: 'UNKNOWN' as const,
        AI_OVERVIEW: 'UNKNOWN' as const,
        MAP_PACK: 'UNKNOWN' as const,
        PEOPLE_ALSO_ASK: 'UNKNOWN' as const,
        SHOPPING_OR_PRODUCT_RESULTS: 'UNKNOWN' as const,
        OTHER: 'UNKNOWN' as const,
      },
      lowConfidenceFields: ['domStructure', 'approximateOrganicPosition'],
      collectorVersion: ASSISTED_CAPTURE_VERSION,
    };
    const capture = await ingestOwnerAssistedCapture(payload, database.pool);
    expect(capture).toMatchObject({
      status: 'CAPTURED',
      device_provenance: 'REAL_DESKTOP_BROWSER',
      requested_location_label: 'Ubon Ratchathani, Thailand',
      job_id: null,
    });
    expect(capture.machine_capture.provenance).toBe('OWNER_ASSISTED_BROWSER_CAPTURE');
    expect((await database.pool.query(`SELECT count(*)::int n FROM jobs`)).rows[0].n).toBe(0);
    await expect(ingestOwnerAssistedCapture(payload, database.pool)).rejects.toThrow(
      'invalid, expired, or already used',
    );
    const repository = (
      await database.pool.query(
        `INSERT INTO site_repositories(site_id,local_path) VALUES($1,'C:/fixture') RETURNING id`,
        [siteId],
      )
    ).rows[0];
    const planRun = (
      await database.pool.query(
        `INSERT INTO source_plan_runs(site_id,opportunity_id,repository_id,status,model,
         reasoning_effort,prompt_version,schema_version,repository_head_sha,source_evidence_hash)
         VALUES($1,$2,$3,'SUCCEEDED','fixture','medium','source-change-plan-prompt-v3','v1',$4,$5)
         RETURNING id`,
        [siteId, opportunityId, repository.id, 'a'.repeat(40), before.evidencePacketHash],
      )
    ).rows[0];
    const planId = (
      await database.pool.query(
        `INSERT INTO source_change_plans(run_id,site_id,opportunity_id,verdict,confidence,
         batch5_reconciliation,summary,structured_output,status)
         VALUES($1,$2,$3,'NEEDS_MORE_EVIDENCE','MEDIUM','REFINED','fixture','{}','READY_FOR_REVIEW')
         RETURNING id`,
        [planRun.id, siteId, opportunityId],
      )
    ).rows[0].id;
    const confirmation = await confirmSerpCapture(
      {
        opportunityId,
        captureId: capture.id,
        displayedTitle: 'Owner-confirmed AMPHON title',
        displayedSnippet: 'Owner-confirmed Thai snippet',
        rankingUrl: 'https://amphon.co.th/notebook',
        approximateOrganicPosition: 3,
        serpFeatures: [],
      },
      database.pool,
    );
    expect(confirmation.corrected).toBe(true);
    const stored = (
      await database.pool.query(
        `SELECT machine_capture,owner_confirmed_value,corrected FROM serp_captures WHERE id=$1`,
        [capture.id],
      )
    ).rows[0];
    expect(stored.machine_capture.displayedTitle).toBeNull();
    expect(stored.owner_confirmed_value.displayedTitle).toBe('Owner-confirmed AMPHON title');
    expect(stored.owner_confirmed_value.provenance).toBe('OWNER_CONFIRMED_BROWSER_CAPTURE');
    expect(stored.corrected).toBe(true);
    const after = await deterministicEvidencePacket(opportunityId, database.pool);
    expect(after.evidencePacketHash).not.toBe(before.evidencePacketHash);
    expect(
      (await database.pool.query(`SELECT status FROM source_change_plans WHERE id=$1`, [planId]))
        .rows[0].status,
    ).toBe('STALE');
    expect((await database.pool.query(`SELECT count(*)::int n FROM ai_usage`)).rows[0].n).toBe(0);
  });

  it('rejects expired, wrong-opportunity, wrong-query, and wrong-domain assisted captures', async () => {
    const make = async () =>
      createBrowserCaptureToken(
        { opportunityId, requestId: serpRequestId, ownerDeclaredLocation: 'Ubon' },
        database.pool,
      );
    const base = (grant: Awaited<ReturnType<typeof make>>): AssistedCapturePayload => ({
      token: grant.token,
      opportunityId,
      query: grant.expectedQuery,
      capturedAt: new Date().toISOString(),
      timezone: 'Asia/Bangkok',
      userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      googleDisplayedLocation: 'Ubon Ratchathani',
      displayedTitle: 'AMPHON',
      displayedSnippet: 'Thai snippet',
      rawHref: 'https://www.google.com/url?q=https%3A%2F%2Famphon.co.th%2Ftarget',
      resolvedLandingUrl: 'https://amphon.co.th/target',
      approximateOrganicPosition: 2,
      features: {
        ADS: 'PRESENT' as const,
        AI_OVERVIEW: 'UNKNOWN' as const,
        MAP_PACK: 'UNKNOWN' as const,
        PEOPLE_ALSO_ASK: 'PRESENT' as const,
        SHOPPING_OR_PRODUCT_RESULTS: 'UNKNOWN' as const,
        OTHER: 'UNKNOWN' as const,
      },
      lowConfidenceFields: [],
      collectorVersion: ASSISTED_CAPTURE_VERSION,
    });

    const wrongOpportunity = await make();
    await expect(
      ingestOwnerAssistedCapture(
        { ...base(wrongOpportunity), opportunityId: '00000000-0000-4000-8000-000000000001' },
        database.pool,
      ),
    ).rejects.toThrow('opportunity');

    const wrongQuery = await make();
    await expect(
      ingestOwnerAssistedCapture({ ...base(wrongQuery), query: 'wrong query' }, database.pool),
    ).rejects.toThrow('query');

    const wrongDomain = await make();
    await expect(
      ingestOwnerAssistedCapture(
        {
          ...base(wrongDomain),
          rawHref: 'https://example.com/',
          resolvedLandingUrl: 'https://example.com/',
        },
        database.pool,
      ),
    ).rejects.toThrow('target domain');

    const expired = await make();
    await database.pool.query(
      `UPDATE browser_capture_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,
      [createHash('sha256').update(expired.token).digest('hex')],
    );
    await expect(ingestOwnerAssistedCapture(base(expired), database.pool)).rejects.toThrow(
      'expired',
    );
  });
});
