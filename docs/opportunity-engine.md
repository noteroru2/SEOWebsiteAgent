# Deterministic opportunity engine

Batch 4 adds a code-only decision layer. `GENERATE_OPPORTUNITIES` is a manually enqueued light job that reads the latest successful crawl, the latest valid GSC summary, bounded current/previous windows, deterministic crawl mappings, and grouped query-page ownership data. It never calls AI, writes to a website, or computes opportunities during page rendering.

## Version and lifecycle

The engine version is `opportunity-engine-v1` and is persisted on generation runs and opportunities. A stable SHA-256 fingerprint contains only site, type, query, URL, and (for blockers) blocker class. Metrics and timestamps are excluded. Repeated runs update the same record. Dismissal persists for the same engine/fingerprint. An open or monitored opportunity must be absent from two consecutive successful runs before it resolves; reappearance resets the missing count and reopens a resolved record.

## Types and evidence gates

All thresholds are centralized in `packages/opportunity-engine/src/index.ts`.

| Type                                   | Final V1 rule                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIKING_DISTANCE_QUERY`              | Position 4–15, at least 20 impressions, deterministic crawl mapping, indexable page, and no blocking issue.                                               |
| `LOW_CTR_QUERY`                        | At least 30 impressions, mapped/indexable page, and CTR at most 60% of a reliable same-position site baseline with at least a two-point absolute deficit. |
| `DECLINING_PAGE`                       | Previous window has at least 30 impressions and there is a material position, click, or impression decline protected by absolute and relative gates.      |
| `DECLINING_QUERY`                      | Same comparison policy at query level, followed by per-page and per-type caps.                                                                            |
| `QUERY_PAGE_OVERLAP_CANDIDATE`         | At least 40 total impressions, two pages with at least 10 impressions, primary share no more than 80%, and secondary share at least 20%.                  |
| `TECHNICAL_BLOCKER_WITH_DEMAND`        | At least 25 impressions plus a deterministic 4xx/5xx, noindex, robots, or non-200 canonical blocker. Cosmetic metadata warnings do not qualify.           |
| `ORPHAN_WITH_SEARCH_DEMAND`            | At least 25 impressions on a mapped page carrying the bounded-crawl `ORPHAN_CANDIDATE` finding.                                                           |
| `INDEXABLE_NOT_IN_SITEMAP_WITH_DEMAND` | At least 25 impressions on a mapped page carrying `INDEXABLE_URL_NOT_IN_SITEMAP`. Sitemap inclusion is not described as a ranking requirement.            |
| `UNMAPPED_GSC_PAGE`                    | At least 20 current impressions and no exact/final/canonical mapping. This remains a cautious diagnostic, normally low confidence.                        |

`GROWING_PAGE` is intentionally omitted. The existing 28-day pilot data does not yet provide a reliable previous window, and adding a positive type only to increase card count would create noise.

## Aggregation methodology

Position buckets are `1`, `2–3`, `4–6`, `7–10`, `11–15`, `16–20`, and `21+`. A bucket baseline is available only with at least 200 total impressions and five distinct queries. Baseline CTR is `sum(clicks) / sum(impressions)`; there is no global or fabricated fallback. Combined position is `sum(position * impressions) / sum(impressions)`.

Current data is the latest finalized 28-day window. Previous data is the preceding 28-day window when present. Decline candidates require a meaningful previous sample and one of:

- weighted position worsens by at least 2 while current impressions remain meaningful;
- clicks fall by at least 40% and five clicks while impressions remain at least 70% comparable;
- impressions fall by at least 40% and 30 impressions.

## Scoring and confidence

Every score is persisted and reconstructable:

- demand: 0–40, logarithmically bounded from impressions with a small click contribution;
- potential: 0–25, type-specific deterministic magnitude;
- evidence strength: 0–20, sample-size and comparison-window strength;
- mapping/technical confidence: 0–15, strongest for exact mapping or deterministic blockers.

Total is capped at 100. `HIGH` is 75+, `MEDIUM` is 50–74, and `LOW` is below 50. Candidates below 42 are suppressed. Confidence is separate: high normally requires at least 100 impressions plus exact mapping or deterministic technical evidence; meaningful smaller mapped samples are medium; unmapped/borderline evidence is low.

## Noise controls

The engine applies minimum evidence gates, fingerprint deduplication, a two-query-opportunity cap per page, per-type caps, an overall cap of 30, overlap dominance suppression, and blocker-aware query gating. Suppression is stored as aggregate reason counts on each run; trivial suppressed signals do not become rows. Overview queries are limited to 100, dashboard to five, site detail to three, and detail joins to 20 crawl findings.

## Limitations and calibration

The engine identifies investigation candidates, not causes or guaranteed fixes. It cannot infer intent, brand effects, SERP features, seasonality, preferred query ownership, or correct remediation. Orphan status is bounded-crawl evidence. URL mapping remains exact/final/canonical only. Threshold changes require a new explicit engine version or a documented compatible calibration backed by fixtures and a real-site review.

Real-data calibration is performed only after synthetic tests pass. Rules—not persisted output rows—are adjusted when obvious noise appears. Generation is expected to finish in seconds and remain below the worker's 256 MiB container ceiling; measured results are reported during Batch acceptance rather than treated as production guarantees.
