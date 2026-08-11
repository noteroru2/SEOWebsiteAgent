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

Queue states remain `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. A partial unique index guarantees one heavy running job. Long jobs heartbeat at most every 15 seconds when progress is reported. Cancellation is checked between requests and partial results are finalized cleanly.

Trust boundaries use Zod and SSRF DNS/IP checks. SQL is parameterized. There is no arbitrary shell route, `eval`, AI call, credential handling, browser automation, or repository mutation.

## Index choices

Indexes cover latest crawls by site/status, crawl-page URL uniqueness, status/indexability/content-hash grouping, and issue severity/code filtering. This supports worker analysis and bounded UI reads without adding indexes for fields unused by current queries.
