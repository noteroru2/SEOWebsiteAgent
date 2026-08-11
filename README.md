# SEO Website Agent V1 — Low Resource Pilot

Local-first foundation for a safe SEO operator. Batch 4 adds a deterministic opportunity engine over the crawler and read-only Google Search Console datasets. It does **not** call AI, generate content, edit managed repositories, deploy, or connect to Hetzner.

## Architecture

- `apps/web`: Next.js App Router, mostly server components and server actions.
- `apps/worker`: one DB-backed worker; only registered job types execute.
- `packages/database`: schema, migrations, queue and summary queries.
- `packages/resource-guard`: portable memory, disk and load safety checks.
- `packages/crawler`: URL safety, robots/sitemap discovery, controlled HTTP fetching, and HTML extraction.
- `packages/seo-engine`: deterministic indexability, issue detection, and compact summaries.
- `packages/gsc`: OAuth security, encrypted credentials, Google REST adapter, bounded pagination, and metric aggregation.
- `packages/opportunity-engine`: deterministic signal rules, scoring, stable fingerprints, suppression, and caps.

PostgreSQL is both the system of record and queue. Claiming uses a transaction, row locking and an advisory lock. A partial unique index enforces at most one heavy `RUNNING` job even with multiple worker processes. Jobs record attempts, timestamps, failures, heartbeats and immutable events. Stale work is returned to `QUEUED` without erasing its attempt count.

## Prerequisites and local setup

Node.js 22+ (24 is supported), npm, Git, and Docker Desktop with Compose. PostgreSQL is exposed on local port `55432` to avoid colliding with an existing local server.

```powershell
Copy-Item .env.example .env
npm.cmd install
docker compose up -d postgres
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev:web
npm.cmd run dev:worker
```

Open `http://localhost:3000`. Add a public HTTP(S) site on **Sites**, select **Run crawl**, then reload its detail page after the worker finishes. Once crawl and GSC evidence exist, opportunity generation can be requested manually from the site page. Browser polling is intentionally absent. `SYSTEM_TEST` remains available on Dashboard and Jobs.

## Docker

`docker compose up --build -d` starts PostgreSQL, web and worker with health checks, a persistent named database volume and practical Compose resource limits. Compose limits are guardrails, not a production sizing guarantee.

## Environment variables

`.env.example` is authoritative and contains placeholders/local-only values. `DATABASE_URL` is required. Google connection additionally requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and a 32-byte `APP_ENCRYPTION_KEY`. Missing Google configuration fails closed. Never commit real credentials.

## Quality and operations

```powershell
npm.cmd run db:migrate
npm.cmd run db:test:prepare
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

Database-backed tests fail closed unless `TEST_DATABASE_URL` explicitly targets a database whose
name ends in `_test`. `npm test` and `npm run test:e2e` create/migrate that separate database and
verify a test-only marker before any destructive reset. They never fall back to `DATABASE_URL`.

Migrations are ordered SQL files in `packages/database/migrations` and applied through Drizzle. Crawl pages store structured SEO fields—not raw HTML—and GSC tables store normalized metrics—not raw API JSON. See [crawler documentation](docs/crawler.md), [technical SEO engine](docs/technical-seo-engine.md), and [Google Search Console](docs/google-search-console.md).

Opportunity generation methodology, scoring, lifecycle, noise controls, and limitations are documented in [docs/opportunity-engine.md](docs/opportunity-engine.md).

## Resource model

The eventual host is a Hetzner CX23 (2 vCPU, 4 GB RAM, 40 GB disk) shared with an existing application. The SEO stack must not assume all host resources belong to it. Default container ceilings total 1.25 GB: PostgreSQL 512 MB, web 512 MB and worker 256 MB. The idle worker sleeps between queue checks; only one heavy job runs. See [docs/resource-model.md](docs/resource-model.md).

## Batch boundary

Production deployment is explicitly **not part of Batch 4**. No deployment, Hetzner connection, Git push, OpenAI/LLM calls, automatic fixes, content generation, or managed-site repository modification is implemented. Batch 5 is not started.
