import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  autoResolveOwnerBusinessConfirmation,
  classifyOwnerFactCandidates,
  confirmReusableOwnerFact,
  confirmSerpCapture,
  createDatabase,
  createSite,
  deterministicEvidencePacket,
  enqueueSerpCapture,
  ensureEvidenceRequest,
  ownerFactStateForOpportunity,
  persistSerpCaptureSuccess,
  requiredOwnerFacts,
} from '@seo-agent/database';
import {
  extractGoogleSerp,
  POSITION_EXTRACTION_VERSION,
  resolveGoogleHref,
  SERP_PARSER_VERSION,
} from '@seo-agent/serp-capture';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

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
});
