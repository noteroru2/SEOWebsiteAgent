# Architecture

The pilot is a small npm-workspaces monorepo with three runtime processes: Next.js web, PostgreSQL, and one TypeScript worker. PostgreSQL is both system of record and persistent queue, avoiding Redis or another service.

Batch 6 adds two manual worker jobs: `REFRESH_SOURCE_REPOSITORY` validates a local Git repository and persists deterministic route metadata; `GENERATE_SOURCE_CHANGE_PLAN` builds one bounded source context and persists one validated plan. Web rendering reads PostgreSQL only and never scans repositories. See [source repository understanding](source-repository-understanding.md) and [source change plans](source-change-plans.md).

Batch 6.4 adds scoped evidence requests/items, equal-window GSC comparison, exact multi-route source packets, and owner-entered evidence. Internal refresh and v3 re-evaluation are separate manual actions; incomplete evidence stops before the provider. See [evidence resolution](evidence-resolution.md).

Automated database tests use a separately created and migrated `seo_agent_test` database in the
same PostgreSQL instance. Destructive test reset is fail-closed behind explicit environment,
database-name, live-connection, and marker checks; it cannot fall back to the development database.

## Data flow

1. A validated server action inserts a heavy `SITE_CRAWL` job.
2. The worker checks host resources and transactionally claims one eligible row.
3. The crawler validates every initial and redirect target against SSRF rules, discovers robots/sitemaps, and performs sequential bounded HTTP requests.
4. Cheerio extracts structured SEO fields. Raw HTML is released after each response and never persisted.
5. Deterministic rules produce issues. Duplicate fields use indexed database `GROUP BY` inserts, not pairwise comparisons.
6. The worker persists pages, issues, lifecycle events, and one compact crawl summary.
7. Server-rendered UI queries the latest summary and at most 100 issues; it never aggregates raw pages during render or polls.

The GSC path uses the same queue with `GSC_SYNC` classified as light. Database indexes prevent overlapping per-site syncs and serialize globally running GSC work. OAuth credentials cross only server routes and the worker: one-time state is hash-validated, token material is AES-256-GCM encrypted, and UI projections exclude credentials. The worker requests finalized day-scoped datasets sequentially, upserts 500-row chunks, precomputes summaries, and discards each API page.

The opportunity path uses the light `GENERATE_OPPORTUNITIES` job. A worker loads bounded, grouped evidence from the latest successful crawl and GSC summary, runs pure deterministic rules, and persists at most 30 scored cards plus an auditable generation run. Stable fingerprints exclude changing metrics and timestamps. Dismissals survive regeneration; an unseen card resolves only after two consecutive successful runs. Server-rendered overview, detail, dashboard, and site queries read persisted cards with explicit limits and do not poll.

The AI path uses a manually enqueued light `ANALYZE_OPPORTUNITY` job for exactly one persisted open or monitored card. The worker constructs bounded structured evidence, performs budget and idempotency checks, calls the Responses API through an injectable adapter, validates strict Structured Outputs, and transactionally persists the analysis, recommendation, and token/cost usage. Identical successful evidence/model/version keys reuse prior output with no call. The opportunity UI reads the latest persisted result and offers an explicit additional-cost reanalysis; rendering never invokes AI. Provider input has no tools and cannot reach crawling, Git, shell, files, publishing, or deployment.

Queue states remain `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. A partial unique index guarantees one heavy running job. Long jobs heartbeat at most every 15 seconds when progress is reported. Cancellation is checked between requests and partial results are finalized cleanly.

Trust boundaries use Zod, SSRF DNS/IP checks, OAuth state validation, server-only authenticated encryption, strict AI Structured Outputs, prompt-data delimiting, and parameterized SQL. There is no arbitrary shell route, `eval`, model tool call, browser crawling, or repository mutation.

## Index choices

Opportunity indexes cover site/status/score, priority, type, last-seen generation, and unique site/engine fingerprints. A partial unique job index prevents overlapping queued or running opportunity generation for one site. The loader aggregates in PostgreSQL and applies row limits before data reaches the worker.

AI indexes cover opportunity/site recency, lifecycle, reuse keys, usage by site/month, and recommendation lookup. A partial expression index prevents duplicate queued/running analysis jobs for the same opportunity.

Indexes cover latest crawls by site/status, crawl-page URL uniqueness, status/indexability/content-hash grouping, and issue severity/code filtering. This supports worker analysis and bounded UI reads without adding indexes for fields unused by current queries.

GSC indexes cover site/property/date access, query/page filters, query×page lookup, latest syncs, idempotent dimension keys, and sync serialization. Raw Google responses and plaintext tokens are never stored.
