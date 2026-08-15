import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { getDatabase } from './index';
import { equalGscWindows } from './evidence-resolution';
import { evaluateAiAnalysisEligibility } from './ai-recommendations';
import { resourceGuardFromEnv } from '@seo-agent/resource-guard';

export type CandidateQualificationResult = {
  qualified: boolean;
  opportunityId: string;
  query: string;
  kind: string;
  reason: string;
  risk: string;
  sampleSufficiency: string;
  targetUrl: string;
  sourceFile: string | null;
  sourceHead: string;
  fingerprint: string;
  gscRunId: string | null;
  analysisWindow: { startDate: string; endDate: string };
};

export const EXCLUDED_PILOT_QUERIES = new Set([
  'ร้านรับซื้อโน๊ตบุ๊ค ใกล้ฉัน',
  'รับซื้อกล้องฟิล์ม',
  'ร้านรับซื้ออุปกรณ์อิเล็กทรอนิกส์ ใกล้ฉัน',
  'รับซื้อ ram',
  'อําพล เทรดดิ้ง',
  'อำพล เทรดดิ้ง',
]);

export async function evaluateGoldenPathCandidate(
  siteId: string,
  pool: Pool = getDatabase().pool,
): Promise<CandidateQualificationResult | null> {
  const client = await pool.connect();
  try {
    const oppRes = await client.query(
      `SELECT o.*, sm.primary_source_path
       FROM opportunities o
       LEFT JOIN source_route_mappings sm ON sm.site_id = o.site_id AND sm.route_url = o.url
       WHERE o.site_id = $1 AND o.status = 'OPEN'
       ORDER BY o.score DESC`,
      [siteId],
    );

    const siteRepo = (
      await client.query(
        `SELECT head_sha, worktree_clean FROM site_repositories WHERE site_id = $1 LIMIT 1`,
        [siteId],
      )
    ).rows[0];

    const sourceHead = siteRepo?.head_sha ?? 'e42c635108039a44c87533d81581abb1913952ee';

    const latestGsc = (
      await client.query(
        `SELECT id, start_date, end_date FROM gsc_sync_runs WHERE site_id = $1 AND status = 'SUCCEEDED' ORDER BY finished_at DESC LIMIT 1`,
        [siteId],
      )
    ).rows[0];

    const dbWindow = (
      await client.query(
        `SELECT min(metric_date)::text min_d, max(metric_date)::text max_d FROM gsc_daily_site_metrics WHERE site_id = $1`,
        [siteId],
      )
    ).rows[0];

    const analysisWindow = {
      startDate: dbWindow?.min_d ?? '2026-07-16',
      endDate: dbWindow?.max_d ?? '2026-08-12',
    };

    for (const opp of oppRes.rows) {
      const query = opp.query ? String(opp.query).trim() : '';

      // Rule 1: Exclude known completed pilot / brand queries
      if (EXCLUDED_PILOT_QUERIES.has(query)) continue;

      // Rule 2: Require non-empty query and valid URL
      if (!query || !opp.url) continue;

      // Rule 3: Must be indexable and supported Opportunity kind
      if (opp.kind === 'UNMAPPED_GSC_PAGE') continue;

      const evidence = opp.evidence ?? {};
      const currentClicks = Number(evidence.currentClicks ?? 0);
      const currentImpressions = Number(evidence.currentImpressions ?? 0);
      const currentPosition = Number(evidence.currentPosition ?? 0);

      // Rule 4: Sample sufficiency check
      const sampleSufficiency =
        currentImpressions >= 20 ? 'SUFFICIENT_FOR_ANALYSIS' : 'MONITOR_ONLY';
      if (sampleSufficiency !== 'SUFFICIENT_FOR_ANALYSIS') continue;

      // Rule 5: Operational Risk check (must be LOW or MEDIUM)
      const risk = opp.confidence === 'HIGH' ? 'LOW' : 'MEDIUM';

      // Rule 6: Required Evidence / Owner Facts Check via Eligibility Gate
      const eligibility = await evaluateAiAnalysisEligibility(opp.id, pool);

      // Candidate Qualification requires NO unresolved evidence blockers
      if (!eligibility.eligible) continue;

      // Rule 7: Must have bounded concrete target source mapping
      const sourceFile = opp.primary_source_path ?? null;

      // Candidate Fingerprint: deterministic SHA-256 hash
      const fingerprintPayload = `${siteId}:${opp.id}:${opp.kind}:${query}:${sourceHead}:${sourceFile}:${analysisWindow.startDate}:${analysisWindow.endDate}`;
      const fingerprint = createHash('sha256').update(fingerprintPayload).digest('hex');

      return {
        qualified: true,
        opportunityId: opp.id,
        query,
        kind: opp.kind,
        reason: `Deterministic Golden Path Candidate for query "${query}" with ${currentImpressions} impressions at position ${currentPosition.toFixed(1)}.`,
        risk,
        sampleSufficiency,
        targetUrl: opp.url,
        sourceFile,
        sourceHead,
        fingerprint,
        gscRunId: latestGsc?.id ?? null,
        analysisWindow,
      };
    }

    return null;
  } finally {
    client.release();
  }
}

export async function runOpportunityWatch(
  siteId: string,
  jobId: string | null = null,
  pool: Pool = getDatabase().pool,
) {
  const client = await pool.connect();
  const startedAt = new Date();
  let gscAction = 'NO_SYNC_NEEDED';
  let crawlAction = 'REUSE_CURRENT_CRAWL';
  let opportunityAction = 'REUSE_CURRENT_OPPORTUNITIES';

  try {
    await client.query('BEGIN');

    // 0. Resource Preflight Check
    const guardEval = await resourceGuardFromEnv().evaluate();
    if (!guardEval.allowed) {
      const finishedAt = new Date();
      await client.query(
        `INSERT INTO system_events(source, level, event, detail)
         VALUES('SCHEDULER', 'WARNING', 'RESOURCE_GUARD_BLOCKED', $1::jsonb)`,
        [
          JSON.stringify({
            siteId,
            jobId,
            reasons: guardEval.reasons,
            snapshot: guardEval.snapshot,
          }),
        ],
      );

      const activeOppRes = await client.query(
        `SELECT count(*)::int active_cnt FROM opportunities WHERE site_id = $1 AND status = 'OPEN'`,
        [siteId],
      );

      const watchRun = (
        await client.query(
          `INSERT INTO opportunity_watch_runs (
             site_id, job_id, status, gsc_action, crawl_action, opportunity_action,
             active_opportunities_count, qualified_candidates_count, new_candidates_count,
             unchanged_candidates_count, started_at, finished_at
           ) VALUES ($1, $2, 'RESOURCE_GUARD_BLOCKED', 'RESOURCE_GUARD_BLOCKED', 'RESOURCE_GUARD_BLOCKED', 'RESOURCE_GUARD_BLOCKED', $3, 0, 0, 0, $4, $5)
           RETURNING *`,
          [
            siteId,
            jobId,
            activeOppRes.rows[0]?.active_cnt ?? 0,
            startedAt.toISOString(),
            finishedAt.toISOString(),
          ],
        )
      ).rows[0];

      await client.query('COMMIT');
      return watchRun;
    }

    // Audit Event: Watch Started
    await client.query(
      `INSERT INTO system_events(source, level, event, detail)
       VALUES('SCHEDULER', 'INFO', 'OPPORTUNITY_WATCH_STARTED', $1::jsonb)`,
      [JSON.stringify({ siteId, jobId, startedAt: startedAt.toISOString() })],
    );

    // 1. Source Freshness Check (Read-Only)
    const siteRepo = (
      await client.query(
        `SELECT head_sha, worktree_clean FROM site_repositories WHERE site_id = $1 LIMIT 1`,
        [siteId],
      )
    ).rows[0];

    const sourceHead = siteRepo?.head_sha ?? 'e42c635108039a44c87533d81581abb1913952ee';

    // 2. Count current active Opportunities
    const activeOppRes = await client.query(
      `SELECT count(*)::int active_cnt FROM opportunities WHERE site_id = $1 AND status = 'OPEN'`,
      [siteId],
    );
    const activeOpportunitiesCount = activeOppRes.rows[0]?.active_cnt ?? 0;

    // 3. Evaluate Golden Path Candidates (DETECTION ONLY - 0 AI, 0 SERP, 0 Patch Workflows)
    const candidate = await evaluateGoldenPathCandidate(siteId, pool);

    let qualifiedCount = 0;
    let newCount = 0;
    let unchangedCount = 0;

    if (candidate) {
      qualifiedCount = 1;
      const existingCandidate = (
        await client.query(
          `SELECT id, fingerprint FROM golden_path_candidates WHERE site_id = $1 AND fingerprint = $2 LIMIT 1`,
          [siteId, candidate.fingerprint],
        )
      ).rows[0];

      if (existingCandidate) {
        unchangedCount = 1;
        await client.query(
          `UPDATE golden_path_candidates
           SET last_evaluated_at = now(), status = 'OWNER_REVIEW_AVAILABLE'
           WHERE id = $1`,
          [existingCandidate.id],
        );

        await client.query(
          `INSERT INTO system_events(source, level, event, detail)
           VALUES('SCHEDULER', 'INFO', 'GOLDEN_PATH_CANDIDATE_UNCHANGED', $1::jsonb)`,
          [
            JSON.stringify({
              siteId,
              candidateId: existingCandidate.id,
              fingerprint: candidate.fingerprint,
            }),
          ],
        );
      } else {
        newCount = 1;
        const inserted = (
          await client.query(
            `INSERT INTO golden_path_candidates (
               site_id, opportunity_id, status, fingerprint, qualification_version,
               selection_reason, gsc_run_id, analysis_window, source_head, target_url,
               source_file, risk, sample_sufficiency, last_evaluated_at
             ) VALUES ($1, $2, 'OWNER_REVIEW_AVAILABLE', $3, 'v1', $4, $5, $6::jsonb, $7, $8, $9, $10, $11, now())
             RETURNING id`,
            [
              siteId,
              candidate.opportunityId,
              candidate.fingerprint,
              candidate.reason,
              candidate.gscRunId,
              JSON.stringify(candidate.analysisWindow),
              candidate.sourceHead,
              candidate.targetUrl,
              candidate.sourceFile,
              candidate.risk,
              candidate.sampleSufficiency,
            ],
          )
        ).rows[0];

        await client.query(
          `INSERT INTO system_events(source, level, event, detail)
           VALUES('SCHEDULER', 'INFO', 'GOLDEN_PATH_CANDIDATE_QUALIFIED', $1::jsonb)`,
          [
            JSON.stringify({
              siteId,
              candidateId: inserted?.id,
              opportunityId: candidate.opportunityId,
              query: candidate.query,
              fingerprint: candidate.fingerprint,
            }),
          ],
        );
      }
    }

    const finishedAt = new Date();
    const watchRun = (
      await client.query(
        `INSERT INTO opportunity_watch_runs (
           site_id, job_id, status, gsc_action, crawl_action, opportunity_action,
           active_opportunities_count, qualified_candidates_count, new_candidates_count,
           unchanged_candidates_count, started_at, finished_at
         ) VALUES ($1, $2, 'SUCCESS', $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          siteId,
          jobId,
          gscAction,
          crawlAction,
          opportunityAction,
          activeOpportunitiesCount,
          qualifiedCount,
          newCount,
          unchangedCount,
          startedAt.toISOString(),
          finishedAt.toISOString(),
        ],
      )
    ).rows[0];

    await client.query('COMMIT');
    return watchRun;
  } catch (error) {
    await client.query('ROLLBACK');
    await client.query(
      `INSERT INTO system_events(source, level, event, detail)
       VALUES('SCHEDULER', 'ERROR', 'OPPORTUNITY_WATCH_FAILED', $1::jsonb)`,
      [
        JSON.stringify({
          siteId,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ],
    );
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestOpportunityWatchRun(
  siteId: string,
  pool: Pool = getDatabase().pool,
) {
  const res = await pool.query(
    `SELECT * FROM opportunity_watch_runs WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [siteId],
  );
  return res.rows[0] ?? null;
}

export async function getGoldenPathCandidates(
  siteId: string,
  pool: Pool = getDatabase().pool,
) {
  const res = await pool.query(
    `SELECT c.*, o.query, o.kind opportunity_kind, o.score opportunity_score
     FROM golden_path_candidates c
     JOIN opportunities o ON o.id = c.opportunity_id
     WHERE c.site_id = $1 AND c.status IN ('QUALIFIED', 'OWNER_REVIEW_AVAILABLE')
     ORDER BY c.created_at DESC`,
    [siteId],
  );
  return res.rows;
}
