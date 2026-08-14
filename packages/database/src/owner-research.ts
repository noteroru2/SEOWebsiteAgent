import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import {
  buildSourceContext,
  inspectRepository,
  type RouteMapping,
  type SourceContext,
} from '@seo-agent/source-understanding';
import {
  classifyOwnerFactCandidates,
  requiredOwnerFacts,
  type OwnerFactRequirement,
} from './evidence-automation';
import { ensureResearchEvidenceRequest, equalGscWindows } from './evidence-resolution';
import { getDatabase } from './index';

export const OWNER_RESEARCH_TYPE = 'OWNER_PRIORITY_SEO' as const;
export const OWNER_RESEARCH_REASON = 'OWNER_BUSINESS_PRIORITY' as const;
export const OWNER_RESEARCH_FOUNDATIONS_VERSION = 'owner-priority-research-v1';
export const OWNER_RESEARCH_V3_CONTEXT_VERSION = 'owner-priority-v3-context-v1';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeOwnerResearchQuery(value: string) {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('th');
  if (!normalized || normalized.length > 200) throw new Error('Valid normalized query required');
  return normalized;
}

function bounded(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`Valid ${label} required`);
  return normalized;
}

function canonicalPage(value: string | undefined, siteUrl: string) {
  if (!value?.trim()) return null;
  const site = new URL(siteUrl);
  const page = new URL(value, site);
  if (page.origin !== site.origin) throw new Error('Research target page must belong to the site');
  page.hash = '';
  page.search = '';
  return page.toString().replace(/\/$/, '');
}

function canonicalUrl(value: string) {
  const page = new URL(value);
  page.hash = '';
  page.search = '';
  return page.toString().replace(/\/$/, '');
}

function routeForUrl(value: string) {
  return decodeURI(new URL(value).pathname).normalize('NFC').replace(/\/$/, '') || '/';
}

export type CreateOwnerResearchCaseInput = {
  siteId: string;
  query: string;
  researchType: typeof OWNER_RESEARCH_TYPE;
  reason: typeof OWNER_RESEARCH_REASON;
  priority: 'NORMAL' | 'HIGH';
  requestedBy: string;
  ownerIntent: string;
  targetPage?: string;
  ownerAuthorized: true;
};

export async function createOwnerResearchCase(
  input: CreateOwnerResearchCaseInput,
  pool: Pool = getDatabase().pool,
) {
  if (input.ownerAuthorized !== true) throw new Error('Explicit owner authorization is required');
  if (input.researchType !== OWNER_RESEARCH_TYPE)
    throw new Error('Canonical owner research type required');
  if (input.reason !== OWNER_RESEARCH_REASON)
    throw new Error('Canonical owner research reason required');
  if (!['NORMAL', 'HIGH'].includes(input.priority))
    throw new Error('Valid owner priority required');
  const query = bounded(input.query.normalize('NFC'), 'research query', 200);
  const normalizedQuery = normalizeOwnerResearchQuery(query);
  const requestedBy = bounded(input.requestedBy, 'requester identity', 100);
  const ownerIntent = bounded(input.ownerIntent, 'owner intent', 1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const site = (
      await client.query(`SELECT * FROM sites WHERE id=$1 AND active=true FOR SHARE`, [
        input.siteId,
      ])
    ).rows[0];
    if (!site) throw new Error('Active site required');
    const targetPage = canonicalPage(input.targetPage, site.url);
    const inserted = await client.query(
      `INSERT INTO owner_research_cases(site_id,query,normalized_query,research_type,status,priority,
        reason,requested_by,owner_intent,target_page,metadata)
       VALUES($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(site_id,normalized_query,research_type)
         WHERE status NOT IN ('CLOSED','CANCELLED') DO NOTHING RETURNING *`,
      [
        input.siteId,
        query,
        normalizedQuery,
        input.researchType,
        input.priority,
        input.reason,
        requestedBy,
        ownerIntent,
        targetPage,
        JSON.stringify({ foundationVersion: OWNER_RESEARCH_FOUNDATIONS_VERSION }),
      ],
    );
    let researchCase = inserted.rows[0];
    const created = Boolean(researchCase);
    if (!researchCase)
      researchCase = (
        await client.query(
          `SELECT * FROM owner_research_cases WHERE site_id=$1 AND normalized_query=$2
           AND research_type=$3 AND status NOT IN ('CLOSED','CANCELLED') FOR UPDATE`,
          [input.siteId, normalizedQuery, input.researchType],
        )
      ).rows[0];
    if (!researchCase) throw new Error('Owner research case identity could not be resolved');
    await client.query(
      `INSERT INTO owner_research_requests(case_id,requested_by,reason,owner_intent)
       VALUES($1,$2,$3,$4)`,
      [researchCase.id, requestedBy, input.reason, ownerIntent],
    );
    await client.query('COMMIT');
    return { researchCase, created, reused: !created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function storedGscContext(researchCase: Record<string, unknown>, pool: Pool) {
  const summary = (
    await pool.query(
      `SELECT to_char(last_finalized_date,'YYYY-MM-DD') last_date FROM gsc_sync_summaries
       WHERE site_id=$1`,
      [researchCase.site_id],
    )
  ).rows[0];
  if (!summary?.last_date)
    return { available: false as const, windows: null, metrics: null, pages: [] };
  const windows = equalGscWindows(summary.last_date);
  const metrics = (
    await pool.query(
      `SELECT coalesce(sum(clicks),0)::float8 clicks,coalesce(sum(impressions),0)::float8 impressions,
       CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,
       CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
       FROM gsc_query_metrics WHERE site_id=$1 AND query=$2 AND metric_date BETWEEN $3 AND $4`,
      [
        researchCase.site_id,
        researchCase.normalized_query,
        windows.current.start,
        windows.current.end,
      ],
    )
  ).rows[0];
  const pages = (
    await pool.query(
      `WITH page_rows AS (
         SELECT page,sum(clicks)::float8 clicks,sum(impressions)::float8 impressions,
          CASE WHEN sum(impressions)>0 THEN sum(clicks)::float8/sum(impressions) ELSE 0 END ctr,
          CASE WHEN sum(impressions)>0 THEN sum(position*impressions)::float8/sum(impressions) ELSE 0 END position
         FROM gsc_query_page_metrics WHERE site_id=$1 AND query=$2 AND metric_date BETWEEN $3 AND $4
         GROUP BY page
       ), totals AS (SELECT coalesce(sum(impressions),0) impressions FROM page_rows)
       SELECT page_rows.*,CASE WHEN totals.impressions>0 THEN page_rows.impressions/totals.impressions ELSE 0 END impression_share
       FROM page_rows,totals ORDER BY page_rows.impressions DESC,page_rows.page`,
      [
        researchCase.site_id,
        researchCase.normalized_query,
        windows.current.start,
        windows.current.end,
      ],
    )
  ).rows;
  return {
    available: Number(metrics.impressions) > 0,
    windows,
    metrics: {
      clicks: Number(metrics.clicks),
      impressions: Number(metrics.impressions),
      ctr: Number(metrics.ctr),
      position: Number(metrics.position),
    },
    pages: pages.map((page) => ({
      ...page,
      clicks: Number(page.clicks),
      impressions: Number(page.impressions),
      ctr: Number(page.ctr),
      position: Number(page.position),
      impression_share: Number(page.impression_share),
    })),
  };
}

async function applicableOwnerFacts(researchCase: Record<string, unknown>, pool: Pool) {
  const requirements = requiredOwnerFacts({ query: String(researchCase.normalized_query) });
  if (!requirements.length)
    return { requirements, matches: [], conflicts: [], missing: requirements };
  const keys = [...new Set(requirements.map((item) => item.factKey))];
  const facts = (
    await pool.query(
      `SELECT * FROM owner_facts WHERE site_id=$1 AND fact_key=ANY($2::text[])
       ORDER BY confirmed_at DESC,id DESC`,
      [researchCase.site_id, keys],
    )
  ).rows;
  const states = requirements.map((requirement) => classifyOwnerFactCandidates(requirement, facts));
  return {
    requirements,
    matches: states.flatMap((state) => (state.match ? [state.match] : [])),
    conflicts: states.filter((state) => state.conflict),
    missing: states.filter((state) => !state.match).map((state) => state.requirement),
  };
}

function routeMapping(row: Record<string, unknown>): RouteMapping {
  return {
    routePath: String(row.route_path),
    status: row.mapping_status as RouteMapping['status'],
    primarySourcePath: row.primary_source_path ? String(row.primary_source_path) : null,
    relatedSourcePaths: (row.related_source_paths ?? []) as string[],
    evidence: (row.mapping_evidence ?? {}) as Record<string, unknown>,
  };
}

async function sourceContext(
  researchCase: Record<string, unknown>,
  primaryPage: string | null,
  pool: Pool,
  allowedRoots?: string[],
) {
  const repository = (
    await pool.query(
      `SELECT * FROM site_repositories WHERE site_id=$1 AND enabled=true
       ORDER BY updated_at DESC LIMIT 1`,
      [researchCase.site_id],
    )
  ).rows[0];
  if (!repository)
    return { available: false as const, repository: null, state: null, mappings: [], contexts: [] };
  const pages = [
    ...(primaryPage ? [{ page: primaryPage, role: 'PRIMARY_GSC_SELECTED' as const }] : []),
    ...(researchCase.target_page
      ? [{ page: String(researchCase.target_page), role: 'OWNER_INTENT_TARGET' as const }]
      : []),
  ];
  const routes = [...new Set(pages.map((item) => routeForUrl(item.page)))];
  const mappingRows = routes.length
    ? (
        await pool.query(
          `SELECT * FROM source_route_mappings WHERE repository_id=$1 AND route_path=ANY($2::text[])
           AND mapping_status NOT IN ('UNRESOLVED','AMBIGUOUS') ORDER BY route_path`,
          [repository.id, routes],
        )
      ).rows
    : [];
  const byRoute = new Map(mappingRows.map((row) => [String(row.route_path), row]));
  const mappings = pages.flatMap((item) => {
    const mapping = byRoute.get(routeForUrl(item.page));
    return mapping ? [{ ...mapping, role: item.role }] : [];
  });
  let state: Awaited<ReturnType<typeof inspectRepository>> | null = null;
  const contexts: Array<{ role: string; context: SourceContext }> = [];
  try {
    state = await inspectRepository(String(repository.local_path), allowedRoots);
    for (const mapping of mappings)
      contexts.push({
        role: String(mapping.role),
        context: await buildSourceContext(state, routeMapping(mapping)),
      });
  } catch {
    return { available: false as const, repository, state, mappings, contexts };
  }
  return {
    available:
      state.clean &&
      Boolean(state.headSha) &&
      routes.every((route) => byRoute.has(route)) &&
      contexts.length === pages.length,
    repository,
    state,
    mappings,
    contexts,
  };
}

function sourceText(contexts: Array<{ role: string; context: SourceContext }>, role: string) {
  return contexts
    .filter((item) => item.role === role)
    .flatMap((item) => item.context.files)
    .flatMap((file) => file.excerpts)
    .map((excerpt) => excerpt.text)
    .join('\n')
    .normalize('NFC');
}

const factSourcePatterns: Partial<Record<string, RegExp>> = {
  'service.accepted_device_types': /Desktop|Mini PC|Workstation|Notebook/i,
  'service.accepts_defective_devices': /เปิดไม่ติด|มีอาการ|defective|non-working/i,
  'service.accepts_multi_unit_lots': /จำนวน|ล็อต|bulk/i,
  'service.pickup_nationwide': /ทั่วประเทศ/,
  'service.valuation_inputs_supported': /Inventory List|Asset Tag|Serial/i,
  'service.preliminary_valuation_available': /ประเมินเบื้องต้น/,
  'service.quotation_available': /ใบเสนอราคา/,
  'service.final_price_after_inspection': /ยืนยันราคา.*ตรวจ|ตรวจ.*ยืนยันราคา/,
  'service.purchase_transaction_document_available': /เอกสาร(?:การ)?ซื้อขาย|เอกสารการซื้อ/,
  'service.seller_receipt_expected': /ใบเสร็จ/,
  'service.data_removal_available': /(?:บริการ|สามารถ).{0,30}(?:ลบ|ทำลาย)ข้อมูล/,
  'service.payment_cash_available': /เงินสด/,
  'service.payment_bank_transfer_available': /โอนเงิน|โอนผ่านธนาคาร/,
};

async function latestCrawlPage(siteId: string, page: string | null, pool: Pool) {
  if (!page) return null;
  const rows = (
    await pool.query(
      `SELECT p.url,p.title,p.meta_description,p.primary_h1,p.created_at FROM crawl_pages p
       JOIN crawl_runs r ON r.id=p.crawl_run_id WHERE r.site_id=$1
       ORDER BY p.created_at DESC`,
      [siteId],
    )
  ).rows;
  const canonical = canonicalUrl(page);
  return (
    rows.find((row) => {
      try {
        return canonicalUrl(String(row.url)) === canonical;
      } catch {
        return false;
      }
    }) ?? null
  );
}

type Finding = {
  type: string;
  status: 'PRESENT' | 'PRESENT_UNPROVEN_HARM' | 'ABSENT' | 'RESOLVED' | 'UNKNOWN';
  summary: string;
  evidence: Record<string, unknown>;
};

export async function reassessOwnerResearchCase(
  caseId: string,
  pool: Pool = getDatabase().pool,
  options: { sourceAllowedRoots?: string[] } = {},
) {
  const researchCase = (
    await pool.query(
      `SELECT c.*,s.url site_url,s.active site_active FROM owner_research_cases c
       JOIN sites s ON s.id=c.site_id WHERE c.id=$1`,
      [caseId],
    )
  ).rows[0];
  if (!researchCase) throw new Error('Owner research case not found');
  const gsc = await storedGscContext(researchCase, pool);
  const primaryPage = gsc.pages[0]?.page ? canonicalUrl(String(gsc.pages[0].page)) : null;
  const [facts, source, crawl] = await Promise.all([
    applicableOwnerFacts(researchCase, pool),
    sourceContext(researchCase, primaryPage, pool, options.sourceAllowedRoots),
    latestCrawlPage(String(researchCase.site_id), primaryPage, pool),
  ]);
  const targetPage = researchCase.target_page
    ? canonicalUrl(String(researchCase.target_page))
    : null;
  const mismatch = Boolean(primaryPage && targetPage && primaryPage !== targetPage);
  const titleContext = (
    [crawl?.title, crawl?.meta_description, crawl?.primary_h1].filter(Boolean).join(' ') ||
    'unknown'
  )
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('th');
  const titleGap = Boolean(crawl && !titleContext.includes(String(researchCase.normalized_query)));
  const targetSource = sourceText(source.contexts, 'OWNER_INTENT_TARGET');
  const missingSourceFacts = facts.matches
    .filter((fact) => {
      const pattern = factSourcePatterns[String(fact.fact_key)];
      return pattern ? !pattern.test(targetSource) : false;
    })
    .map((fact) => String(fact.fact_key));
  const findings: Finding[] = [
    {
      type: 'PAGE_INTENT_MISMATCH',
      status: mismatch ? 'PRESENT' : primaryPage && targetPage ? 'ABSENT' : 'UNKNOWN',
      summary: mismatch
        ? 'Predominant GSC page differs from the owner-intent target page.'
        : 'No deterministic page-intent mismatch established.',
      evidence: { primaryPage, targetPage },
    },
    {
      type: 'POTENTIAL_CANNIBALIZATION',
      status: mismatch && gsc.pages.length > 1 ? 'PRESENT_UNPROVEN_HARM' : 'ABSENT',
      summary:
        mismatch && gsc.pages.length > 1
          ? 'Multiple pages receive query impressions; harmful cannibalization is not proven.'
          : 'No multi-page ownership conflict established.',
      evidence: {
        pages: gsc.pages.map((page) => ({ page: page.page, impressions: page.impressions })),
      },
    },
    {
      type: 'TITLE_META_ALIGNMENT_GAP',
      status: crawl ? (titleGap ? 'PRESENT' : 'ABSENT') : 'UNKNOWN',
      summary: titleGap
        ? 'Predominant ranking page title, meta description, and H1 do not contain the normalized query.'
        : crawl
          ? 'Predominant ranking page metadata includes the normalized query.'
          : 'Current crawl metadata is unavailable.',
      evidence: crawl
        ? {
            page: primaryPage,
            title: crawl.title,
            metaDescription: crawl.meta_description,
            h1: crawl.primary_h1,
          }
        : { page: primaryPage },
    },
    {
      type: 'BUSINESS_PROCESS_GAP',
      status: !source.available ? 'UNKNOWN' : missingSourceFacts.length ? 'PRESENT' : 'ABSENT',
      summary: !source.available
        ? 'Mapped source context is unavailable.'
        : missingSourceFacts.length
          ? 'Confirmed business capabilities are not all represented in the target source page.'
          : 'All bounded confirmed capabilities are represented in the target source page.',
      evidence: { missingFactKeys: missingSourceFacts },
    },
    {
      type: 'INSUFFICIENT_BUSINESS_EVIDENCE',
      status:
        facts.matches.length === facts.requirements.length && !facts.conflicts.length
          ? 'RESOLVED'
          : 'PRESENT',
      summary:
        facts.matches.length === facts.requirements.length && !facts.conflicts.length
          ? 'All required bounded owner facts are active and conflict-free.'
          : 'Applicable owner facts are missing or conflicting.',
      evidence: {
        required: facts.requirements.length,
        applicable: facts.matches.length,
        missing: facts.missing.map((item) => item.factKey),
        conflicts: facts.conflicts.map((item) => item.requirement.factKey),
      },
    },
  ];
  await Promise.all([
    ensureResearchEvidenceRequest(
      {
        ownerResearchCaseId: caseId,
        type: 'RESEARCH_SERP_OBSERVATION',
        requirement: 'Optional supporting non-hyperlocal SERP observation',
        reason: 'Supporting evidence only; owner authorization and quota required',
        source: 'OWNER_AUTHORIZED_SERP_OR_MANUAL',
        required: false,
      },
      pool,
    ),
    ensureResearchEvidenceRequest(
      {
        ownerResearchCaseId: caseId,
        type: 'RESEARCH_NEWER_GSC_WINDOW',
        requirement: 'Optional newer finalized GSC window',
        reason: 'Current stored finalized window is sufficient for initial analysis',
        source: 'STORED_GSC_ONLY',
        required: false,
      },
      pool,
    ),
  ]);
  const blockers = [
    ...(!researchCase.site_active ? ['ACTIVE_SITE_REQUIRED'] : []),
    ...(!gsc.available ? ['STORED_GSC_REQUIRED'] : []),
    ...(!gsc.pages.length ? ['QUERY_PAGE_CONTEXT_REQUIRED'] : []),
    ...(!targetPage ? ['OWNER_TARGET_PAGE_REQUIRED'] : []),
    ...(!source.available ? ['CLEAN_MAPPED_SOURCE_REQUIRED'] : []),
    ...(facts.missing.length ? ['APPLICABLE_OWNER_FACTS_REQUIRED'] : []),
    ...(facts.conflicts.length ? ['OWNER_FACT_CONFLICT_REVIEW_REQUIRED'] : []),
  ];
  const status = blockers.length ? 'WAITING_FOR_EVIDENCE' : 'READY_FOR_ANALYSIS';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM owner_research_fact_links WHERE case_id=$1`, [caseId]);
    for (const fact of facts.matches)
      await client.query(
        `INSERT INTO owner_research_fact_links(case_id,fact_id,fact_hash) VALUES($1,$2,$3)`,
        [caseId, fact.id, fact.fact_hash],
      );
    await client.query(`DELETE FROM owner_research_source_links WHERE case_id=$1`, [caseId]);
    for (const mapping of source.state ? source.mappings : [])
      await client.query(
        `INSERT INTO owner_research_source_links(case_id,mapping_id,role,source_head_sha)
         VALUES($1,$2,$3,$4)`,
        [caseId, mapping.id, mapping.role, source.state?.headSha],
      );
    for (const finding of findings)
      await client.query(
        `INSERT INTO owner_research_findings(case_id,finding_type,finding_status,summary,evidence)
         VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT(case_id,finding_type) DO UPDATE SET finding_status=excluded.finding_status,
           summary=excluded.summary,evidence=excluded.evidence,assessed_at=now(),updated_at=now()`,
        [caseId, finding.type, finding.status, finding.summary, JSON.stringify(finding.evidence)],
      );
    await client.query(
      `UPDATE owner_research_cases SET status=$2,primary_gsc_page=$3,repository_id=$4,
       source_head_sha=$5,last_assessed_at=now(),updated_at=now() WHERE id=$1`,
      [caseId, status, primaryPage, source.repository?.id ?? null, source.state?.headSha ?? null],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    caseId,
    status,
    readyForAnalysis: !blockers.length,
    blockers,
    gsc,
    source: {
      available: source.available,
      headSha: source.state?.headSha ?? null,
      clean: source.state?.clean ?? null,
      mappings: source.mappings.map((mapping) => ({
        id: mapping.id,
        routePath: mapping.route_path,
        role: mapping.role,
        primarySourcePath: mapping.primary_source_path,
      })),
    },
    ownerFacts: {
      required: facts.requirements.length,
      applicable: facts.matches.length,
      missing: facts.missing.map((item: OwnerFactRequirement) => item.factKey),
      conflicts: facts.conflicts.map((item) => item.requirement.factKey),
    },
    findings,
    evidenceReadiness: {
      gsc: gsc.available ? 'NOT_NEEDED' : 'REQUIRED',
      queryPage: gsc.pages.length ? 'NOT_NEEDED' : 'REQUIRED',
      source: source.available ? 'NOT_NEEDED' : 'REQUIRED',
      ownerFacts: facts.missing.length || facts.conflicts.length ? 'REQUIRED' : 'NOT_NEEDED',
      serp: 'OPTIONAL',
      newerGsc: 'OPTIONAL',
      deviceEvidence: 'NOT_NEEDED',
    },
    ownerAuthorizationRequiredForAi: true,
    changeCandidate: false,
    patchEligible: false,
    readyForBatch7: false,
  };
}

export async function getOwnerResearchCase(caseId: string, pool: Pool = getDatabase().pool) {
  const researchCase = (
    await pool.query(
      `SELECT c.*,s.name site_name,s.url site_url FROM owner_research_cases c
       JOIN sites s ON s.id=c.site_id WHERE c.id=$1`,
      [caseId],
    )
  ).rows[0];
  if (!researchCase) return null;
  const [requests, evidenceRequests, facts, sources, findings] = await Promise.all([
    pool.query(`SELECT * FROM owner_research_requests WHERE case_id=$1 ORDER BY requested_at,id`, [
      caseId,
    ]),
    pool.query(
      `SELECT * FROM evidence_requests WHERE owner_research_case_id=$1 AND status<>'SUPERSEDED'
       ORDER BY created_at,id`,
      [caseId],
    ),
    pool.query(
      `SELECT f.*,l.fact_hash linked_fact_hash,l.linked_at FROM owner_research_fact_links l
       JOIN owner_facts f ON f.id=l.fact_id WHERE l.case_id=$1 ORDER BY f.fact_key,f.id`,
      [caseId],
    ),
    pool.query(
      `SELECT l.*,m.route_path,m.mapping_status,m.primary_source_path FROM owner_research_source_links l
       JOIN source_route_mappings m ON m.id=l.mapping_id WHERE l.case_id=$1 ORDER BY l.role,m.route_path`,
      [caseId],
    ),
    pool.query(`SELECT * FROM owner_research_findings WHERE case_id=$1 ORDER BY finding_type`, [
      caseId,
    ]),
  ]);
  return {
    researchCase,
    ownerRequests: requests.rows,
    evidenceRequests: evidenceRequests.rows,
    ownerFacts: facts.rows,
    sourceMappings: sources.rows,
    findings: findings.rows,
  };
}

export async function buildOwnerResearchV3Context(caseId: string, pool: Pool = getDatabase().pool) {
  const record = await getOwnerResearchCase(caseId, pool);
  if (!record)
    throw Object.assign(new Error('Owner research case not found'), {
      code: 'OWNER_RESEARCH_REQUIRED',
    });
  const researchCase = record.researchCase;
  if (researchCase.status !== 'READY_FOR_ANALYSIS')
    throw Object.assign(new Error('Owner research case is not ready for analysis'), {
      code: 'OWNER_RESEARCH_NOT_READY',
    });
  if (researchCase.opportunity_id)
    throw Object.assign(new Error('Owner research V3 cannot use a linked Opportunity'), {
      code: 'ANALYSIS_SUBJECT_AMBIGUOUS',
    });
  const gsc = await storedGscContext(researchCase, pool);
  if (!gsc.available || !gsc.pages.length)
    throw Object.assign(new Error('Stored GSC context is required'), { code: 'GSC_DATA_REQUIRED' });
  const conflicts = await pool.query(
    `SELECT f.fact_key FROM owner_research_fact_links l JOIN owner_facts f ON f.id=l.fact_id
     WHERE l.case_id=$1 AND f.status='ACTIVE' GROUP BY f.fact_key
     HAVING count(DISTINCT f.value_json::text)>1`,
    [caseId],
  );
  if (record.ownerFacts.length !== 13 || conflicts.rows.length)
    throw Object.assign(new Error('Exactly 13 conflict-free owner facts are required'), {
      code: 'OWNER_FACT_PREFLIGHT_FAILED',
    });
  if (!researchCase.source_head_sha || record.sourceMappings.length < 2)
    throw Object.assign(new Error('Current mapped source context is required'), {
      code: 'SOURCE_MAPPING_REQUIRED',
    });
  const evidence = (
    await pool.query(
      `SELECT r.id request_id,r.type,r.required,r.status,i.id item_id,i.source_type,i.evidence,
        i.evidence_hash,i.observed_at,i.observed_timezone
       FROM evidence_requests r LEFT JOIN evidence_items i ON i.request_id=r.id
       WHERE r.owner_research_case_id=$1 AND r.status<>'SUPERSEDED'
       ORDER BY r.created_at,r.id,i.observed_at NULLS LAST,i.created_at,i.id`,
      [caseId],
    )
  ).rows;
  const acceptedEvidence = evidence
    .filter((item) => item.item_id)
    .map((item) => ({
      requestId: item.request_id,
      type: item.type,
      sourceType: item.source_type,
      evidence: item.evidence,
      evidenceHash: item.evidence_hash,
      observedAt: item.observed_at ? new Date(item.observed_at).toISOString() : null,
      observedTimezone: item.observed_timezone,
    }));
  const packet = {
    contextVersion: OWNER_RESEARCH_V3_CONTEXT_VERSION,
    subject: {
      type: 'OWNER_RESEARCH_CASE' as const,
      id: researchCase.id,
      researchType: researchCase.research_type,
      query: researchCase.query,
      normalizedQuery: researchCase.normalized_query,
      reason: researchCase.reason,
      ownerRequestLanguage:
        'The owner requested research on this commercially important query; this is context, not ranking evidence or change authorization.',
      targetPage: researchCase.target_page,
      primaryGscPage: researchCase.primary_gsc_page,
    },
    gsc: {
      availability: 'STORED_FINALIZED',
      period: gsc.windows?.current ?? null,
      metrics: gsc.metrics,
      queryPageDistribution: gsc.pages,
      sampleCaution:
        'LOW_SAMPLE: 15 impressions, 0 clicks, and no comparable previous sample; do not infer CTR causality or ranking loss.',
      queryOwnershipInterpretation:
        '14/15 impressions map to the office page and 1/15 to the company page; POTENTIAL_CANNIBALIZATION with UNPROVEN harm.',
    },
    deterministicFindings: record.findings.map((finding) => ({
      type: finding.finding_type,
      status: finding.finding_status,
      summary: finding.summary,
      evidence: finding.evidence,
    })),
    source: {
      headSha: researchCase.source_head_sha,
      mappings: record.sourceMappings.map((mapping) => ({
        role: mapping.role,
        routePath: mapping.route_path,
        mappingStatus: mapping.mapping_status,
        primarySourcePath: mapping.primary_source_path,
        sourceHeadSha: mapping.source_head_sha,
      })),
    },
    ownerFacts: record.ownerFacts.map((fact) => ({
      factId: fact.id,
      canonicalKey: fact.fact_key,
      scope: { type: fact.scope_type, key: fact.scope_key },
      value: fact.value_json,
      factHash: fact.fact_hash,
      provenance: 'OWNER_CONFIRMED_DIRECT',
      reviewStatus: 'OWNER_CONFIRMED',
      status: fact.status,
    })),
    evidence: {
      items: acceptedEvidence,
      requirements: evidence
        .filter((item) => !item.item_id)
        .map((item) => ({ type: item.type, required: item.required, status: item.status })),
      serp: acceptedEvidence.some((item) => item.type === 'RESEARCH_SERP_OBSERVATION')
        ? 'AVAILABLE'
        : 'NONE',
      newerGsc: acceptedEvidence.some((item) => item.type === 'RESEARCH_NEWER_GSC_WINDOW')
        ? 'AVAILABLE'
        : 'NONE',
    },
    excludedUnconfirmedClaims: [
      'VAT registration',
      'tax invoice',
      'withholding tax',
      'minimum pickup quantity or value',
      'free pickup',
      'same-day pickup or pickup SLA',
      'certified wiping or NIST/DoD compliance',
      'physical shredding or destruction certificate',
    ],
  };
  return {
    packet,
    contextHash: createHash('sha256').update(stable(packet)).digest('hex'),
  };
}

export async function recordOwnerResearchAiAuthorization(
  input: {
    caseId: string;
    authorizationRef: string;
    authorizedBy: string;
    ownerAuthorized: true;
  },
  pool: Pool = getDatabase().pool,
) {
  if (input.ownerAuthorized !== true) throw new Error('Explicit owner authorization is required');
  const result = await pool.query(
    `INSERT INTO owner_research_ai_authorizations(case_id,authorization_ref,authorized_by)
     SELECT id,$2,$3 FROM owner_research_cases WHERE id=$1 AND status='READY_FOR_ANALYSIS'
     RETURNING *`,
    [
      input.caseId,
      bounded(input.authorizationRef, 'authorization reference', 300),
      bounded(input.authorizedBy, 'authorizer', 100),
    ],
  );
  if (!result.rows[0]) throw new Error('Ready Owner Research case required');
  return result.rows[0];
}

export async function consumeOwnerResearchAiAuthorization(
  input: { authorizationId: string; caseId: string; jobId: string; runId: string },
  pool: Pool = getDatabase().pool,
) {
  const result = await pool.query(
    `UPDATE owner_research_ai_authorizations SET status='CONSUMED',consumed_at=now(),job_id=$3,
       run_id=$4,updated_at=now() WHERE id=$1 AND case_id=$2 AND status='AUTHORIZED'
       AND consumed_at IS NULL AND job_id IS NULL AND run_id IS NULL RETURNING *`,
    [input.authorizationId, input.caseId, input.jobId, input.runId],
  );
  if (!result.rows[0])
    throw Object.assign(new Error('Fresh one-time Owner Research authorization required'), {
      code: 'OWNER_AUTHORIZATION_REQUIRED',
    });
  return result.rows[0];
}

export async function diagnoseSerpQuota(pool: Pool = getDatabase().pool) {
  const result = await pool.query(
    `SELECT c.provider,c.enabled,c.health,p.configured_allowance,coalesce(p.used,0)::int used,
      coalesce(p.reserved,0)::int reserved,
      greatest(coalesce(p.configured_allowance,0)-coalesce(p.used,0)-coalesce(p.reserved,0),0)::int remaining,
      (SELECT coalesce(sum(all_periods.used),0)::int FROM serp_provider_usage_periods all_periods
       WHERE all_periods.provider=c.provider) historical_used
     FROM serp_provider_configs c LEFT JOIN LATERAL (
       SELECT * FROM serp_provider_usage_periods p WHERE p.provider=c.provider
       AND p.period_start<=now() AND (p.period_end IS NULL OR p.period_end>now())
       ORDER BY p.period_start DESC LIMIT 1
     ) p ON true ORDER BY c.priority`,
  );
  const serpApi = result.rows.find((row) => row.provider === 'SERPAPI') ?? null;
  const state =
    serpApi && Number(serpApi.remaining) === 0
      ? 'INTERNAL_DISABLED'
      : serpApi
        ? 'KNOWN_SAFE'
        : 'UNKNOWN';
  return {
    state,
    reason:
      state === 'INTERNAL_DISABLED'
        ? 'The active project-managed allowance is exhausted; external provider quota was not contacted and remains unknown.'
        : state === 'KNOWN_SAFE'
          ? 'Project-managed allowance metadata is internally consistent.'
          : 'No local SerpApi allowance metadata is available.',
    provider: serpApi,
    externalProviderQuota: 'UNKNOWN',
  };
}
