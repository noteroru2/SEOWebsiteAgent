import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  classifyOwnerFactCandidates,
  companyComputerOwnerFactValues,
  confirmDirectOwnerFact,
  createDatabase,
  createSite,
  ensureEvidenceRequest,
  ownerFactStateForOpportunity,
  recordEvidenceItem,
  requiredOwnerFacts,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../packages/database/src/test-safety';

const database = createDatabase(requireTestDatabaseUrl());
let siteId = '';

const directInput = (item: (typeof companyComputerOwnerFactValues)[number]) => ({
  siteId,
  factKey: item.factKey,
  value: item.value,
  scopeType: item.scopeType,
  scopeKey: item.scopeKey,
  provenance: 'OWNER_CONFIRMED_DIRECT' as const,
  reviewStatus: 'OWNER_CONFIRMED' as const,
  confirmedBy: 'LOCAL_OWNER',
  sourceContext: 'company-computer-owner-confirmation-test',
  ownerAuthorized: true as const,
});

describe('opportunity-independent owner facts', () => {
  beforeAll(async () => migrate(database.db, { migrationsFolder: 'packages/database/migrations' }));
  beforeEach(async () => {
    await resetTestDatabase(database.pool);
    siteId = (
      await createSite(
        { name: 'Direct Owner Facts Fixture', url: 'https://facts.example.test/' },
        database.db,
      )
    ).id;
  });
  afterAll(async () => database.pool.end());

  it('persists direct provenance without an opportunity or evidence request and triggers nothing', async () => {
    const result = await confirmDirectOwnerFact(
      directInput(companyComputerOwnerFactValues[0]),
      database.pool,
    );
    expect(result).toMatchObject({ created: true, reused: false, conflict: false });
    expect(result.fact.source_evidence_item_id).toBeNull();
    expect(result.fact.direct_confirmation_id).toBe(result.confirmation.id);
    expect(result.confirmation).toMatchObject({
      provenance: 'OWNER_CONFIRMED_DIRECT',
      review_status: 'OWNER_CONFIRMED',
      confirmed_by: 'LOCAL_OWNER',
    });
    const counts = (
      await database.pool.query(
        `SELECT
          (SELECT count(*)::int FROM opportunities) opportunities,
          (SELECT count(*)::int FROM evidence_requests) evidence_requests,
          (SELECT count(*)::int FROM ai_usage) ai_usage,
          (SELECT count(*)::int FROM serp_api_captures) serp_captures,
          (SELECT count(*)::int FROM jobs) jobs`,
      )
    ).rows[0];
    expect(counts).toEqual({
      opportunities: 0,
      evidence_requests: 0,
      ai_usage: 0,
      serp_captures: 0,
      jobs: 0,
    });
  });

  it('enforces exactly one provenance source while preserving legacy evidence-linked facts', async () => {
    await expect(
      database.pool.query(
        `INSERT INTO owner_facts(site_id,fact_key,value_json,scope_type,scope_key,status,
          confirmed_by,fact_hash) VALUES($1,'invalid.no_provenance','true','SERVICE','invalid',
          'ACTIVE','LOCAL_OWNER',$2)`,
        [siteId, '0'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const opportunityId = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
         VALUES($1,'LOW_CTR_QUERY','legacy','Legacy','Legacy evidence','legacy-owner-fact','OPEN') RETURNING id`,
        [siteId],
      )
    ).rows[0].id;
    const request = await ensureEvidenceRequest(
      {
        opportunityId,
        type: 'OWNER_BUSINESS_CONFIRMATION',
        requirement: 'Legacy direct confirmation',
        reason: 'regression',
        source: 'OWNER',
      },
      database.pool,
    );
    const evidence = await recordEvidenceItem(
      request.id,
      'OWNER_CONFIRMED_DIRECT',
      { factKey: 'legacy.fact', value: true },
      undefined,
      database.pool,
    );
    const legacy = (
      await database.pool.query(
        `INSERT INTO owner_facts(site_id,fact_key,value_json,scope_type,scope_key,status,
          source_evidence_item_id,confirmed_by,fact_hash)
         VALUES($1,'legacy.fact','true','SERVICE','legacy','ACTIVE',$2,'LOCAL_OWNER',$3) RETURNING *`,
        [siteId, evidence.id, '1'.repeat(64)],
      )
    ).rows[0];
    expect(legacy.source_evidence_item_id).toBe(evidence.id);
    expect(legacy.direct_confirmation_id).toBeNull();
    const direct = await confirmDirectOwnerFact(
      directInput(companyComputerOwnerFactValues[0]),
      database.pool,
    );
    await expect(
      database.pool.query(
        `INSERT INTO owner_facts(site_id,fact_key,value_json,scope_type,scope_key,status,
          source_evidence_item_id,direct_confirmation_id,confirmed_by,fact_hash)
         VALUES($1,'invalid.two_sources','true','SERVICE','invalid','ACTIVE',$2,$3,
          'LOCAL_OWNER',$4)`,
        [siteId, evidence.id, direct.confirmation.id, '2'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      classifyOwnerFactCandidates(
        {
          factKey: 'legacy.fact',
          label: 'Legacy fact',
          scopeType: 'SERVICE',
          scopeKey: 'legacy',
          reviewDays: 180,
          expectedValue: true,
        },
        [legacy],
      ).match,
    ).toBeTruthy();
  });

  it('is idempotent and appends confirmation audit records', async () => {
    const input = directInput(companyComputerOwnerFactValues[5]);
    const first = await confirmDirectOwnerFact(input, database.pool);
    const second = await confirmDirectOwnerFact(input, database.pool);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, reused: true, conflict: false });
    expect(second.fact.id).toBe(first.fact.id);
    const counts = (
      await database.pool.query(
        `SELECT
          (SELECT count(*)::int FROM owner_facts) facts,
          (SELECT count(*)::int FROM owner_fact_confirmations) confirmations,
          (SELECT count(*)::int FROM owner_fact_confirmation_links) links`,
      )
    ).rows[0];
    expect(counts).toEqual({ facts: 1, confirmations: 2, links: 2 });
  });

  it('preserves contradictory direct confirmations for explicit review', async () => {
    const definition = companyComputerOwnerFactValues.find(
      (item) => item.factKey === 'service.payment_cash_available',
    )!;
    await confirmDirectOwnerFact(directInput(definition), database.pool);
    const contradiction = await confirmDirectOwnerFact(
      { ...directInput(definition), value: false, sourceContext: 'future-owner-correction' },
      database.pool,
    );
    expect(contradiction).toMatchObject({ created: true, conflict: true });
    const rows = await database.pool.query(
      `SELECT value_json,status FROM owner_facts WHERE site_id=$1 AND fact_key=$2 ORDER BY value_json::text`,
      [siteId, definition.factKey],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.status === 'ACTIVE')).toBe(true);
  });

  it('validates canonical keys, owner authorization, scopes, and bounded values', async () => {
    const definition = companyComputerOwnerFactValues[0];
    await expect(
      confirmDirectOwnerFact(
        { ...directInput(definition), ownerAuthorized: false } as never,
        database.pool,
      ),
    ).rejects.toThrow('Explicit owner authorization');
    await expect(
      confirmDirectOwnerFact(
        { ...directInput(definition), factKey: 'service.vat_registered' } as never,
        database.pool,
      ),
    ).rejects.toThrow('Unsupported canonical owner fact key');
    await expect(
      confirmDirectOwnerFact(
        { ...directInput(definition), scopeKey: 'wrong-service' },
        database.pool,
      ),
    ).rejects.toThrow('scope does not match');
    await expect(
      confirmDirectOwnerFact(
        { ...directInput(definition), value: [...definition.value, 'CERTIFIED_WIPING'] },
        database.pool,
      ),
    ).rejects.toThrow('unsupported canonical value');
  });

  it('supports SERVICE, PRODUCT_CATEGORY, and SERVICE_GEOGRAPHY scopes', async () => {
    const selected = [
      companyComputerOwnerFactValues.find((item) => item.scopeType === 'SERVICE')!,
      companyComputerOwnerFactValues.find((item) => item.scopeType === 'PRODUCT_CATEGORY')!,
      companyComputerOwnerFactValues.find((item) => item.scopeType === 'SERVICE_GEOGRAPHY')!,
    ];
    for (const item of selected) await confirmDirectOwnerFact(directInput(item), database.pool);
    const rows = await database.pool.query(
      `SELECT scope_type,count(*)::int count FROM owner_facts GROUP BY scope_type ORDER BY scope_type`,
    );
    expect(rows.rows).toEqual([
      { scope_type: 'PRODUCT_CATEGORY', count: 1 },
      { scope_type: 'SERVICE', count: 1 },
      { scope_type: 'SERVICE_GEOGRAPHY', count: 1 },
    ]);
  });

  it('lets a future company-computer opportunity consume direct facts without creating evidence', async () => {
    for (const item of companyComputerOwnerFactValues)
      await confirmDirectOwnerFact(directInput(item), database.pool);
    const opportunityId = (
      await database.pool.query(
        `INSERT INTO opportunities(site_id,kind,query,title,summary,fingerprint,status)
         VALUES($1,'LOW_CTR_QUERY','รับซื้อคอมบริษัท','Company computers','Future opportunity',
           'future-company-computer','OPEN') RETURNING id`,
        [siteId],
      )
    ).rows[0].id;
    const state = await ownerFactStateForOpportunity(opportunityId, database.pool);
    expect(state.complete).toBe(true);
    expect(state.requirements).toHaveLength(companyComputerOwnerFactValues.length);
    expect(state.requirements.every((item) => item.match?.direct_confirmation_id)).toBe(true);
    expect(
      (await database.pool.query(`SELECT count(*)::int count FROM evidence_requests`)).rows[0]
        .count,
    ).toBe(0);
  });

  it('keeps prohibited claims absent from the canonical registry and stored direct facts', async () => {
    for (const item of companyComputerOwnerFactValues)
      await confirmDirectOwnerFact(directInput(item), database.pool);
    const stored = JSON.stringify(
      (
        await database.pool.query(
          `SELECT fact_key,value_json,metadata FROM owner_facts WHERE site_id=$1 ORDER BY fact_key`,
          [siteId],
        )
      ).rows,
    ).toLowerCase();
    for (const forbidden of [
      'vat',
      'tax invoice',
      'withholding',
      'certified',
      'certificate',
      'nist',
      'dod',
      'free pickup',
      'same-day',
      'minimum quantity',
      'minimum value',
    ])
      expect(stored).not.toContain(forbidden);
    expect(requiredOwnerFacts({ query: 'รับซื้อคอมบริษัท' })).toHaveLength(
      companyComputerOwnerFactValues.length,
    );
  });
});
