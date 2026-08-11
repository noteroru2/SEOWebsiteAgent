# Architecture

The pilot is a small npm-workspaces monorepo with three runtime processes: Next.js web, PostgreSQL, and one TypeScript worker. PostgreSQL is both system of record and persistent queue, avoiding Redis or another service.

## Data flow

1. A validated server action inserts a heavy `SITE_CRAWL` job.
2. The worker checks host resources and transactionally claims one eligible row.
3. The crawler validates every initial and redirect target against SSRF rules, discovers robots/sitemaps, and performs sequential bounded HTTP requests.
4. Cheerio extracts structured SEO fields. Raw HTML is released after each response and never persisted.
5. Deterministic rules produce issues. Duplicate fields use indexed database `GROUP BY` inserts, not pairwise comparisons.
6. The worker persists pages, issues, lifecycle events, and one compact crawl summary.
7. Server-rendered UI queries the latest summary and at most 100 issues; it never aggregates raw pages during render or polls.

The GSC path uses the same queue with `GSC_SYNC` classified as light. Database indexes prevent overlapping per-site syncs and serialize globally running GSC work. OAuth credentials cross only server routes and the worker: one-time state is hash-validated, token material is AES-256-GCM encrypted, and UI projections exclude credentials. The worker requests finalized day-scoped datasets sequentially, upserts 500-row chunks, precomputes summaries, and discards each API page.

Queue states remain `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. A partial unique index guarantees one heavy running job. Long jobs heartbeat at most every 15 seconds when progress is reported. Cancellation is checked between requests and partial results are finalized cleanly.

Trust boundaries use Zod, SSRF DNS/IP checks, OAuth state validation, server-only authenticated encryption, and parameterized SQL. There is no arbitrary shell route, `eval`, AI call, browser crawling, or repository mutation.

## Index choices

Indexes cover latest crawls by site/status, crawl-page URL uniqueness, status/indexability/content-hash grouping, and issue severity/code filtering. This supports worker analysis and bounded UI reads without adding indexes for fields unused by current queries.

GSC indexes cover site/property/date access, query/page filters, query×page lookup, latest syncs, idempotent dimension keys, and sync serialization. Raw Google responses and plaintext tokens are never stored.
