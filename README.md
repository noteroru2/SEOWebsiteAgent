# SEO Website Agent V1 — Low Resource Pilot

Local-first Batch 1 foundation for a safe SEO operator. It provides a Next.js dashboard, PostgreSQL/Drizzle data layer, persistent database queue, one low-resource worker, audit events, resource checks, and a complete `SYSTEM_TEST` demonstration. It does **not** crawl production sites, call AI or Google APIs, edit repositories, deploy, or connect to Hetzner.

## Architecture

- `apps/web`: Next.js App Router, mostly server components and server actions.
- `apps/worker`: one DB-backed worker; only registered job types execute.
- `packages/database`: schema, migrations, queue and summary queries.
- `packages/resource-guard`: portable memory, disk and load safety checks.
- Remaining packages define narrow future-facing contracts only.

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

Open `http://localhost:3000`. Select **Run system test**, allow the worker to claim it, then reload the Jobs page. Browser polling is intentionally absent.

## Docker

`docker compose up --build -d` starts PostgreSQL, web and worker with health checks, a persistent named database volume and practical Compose resource limits. Compose limits are guardrails, not a production sizing guarantee.

## Environment variables

`.env.example` is authoritative and contains placeholders/local-only values. `DATABASE_URL` is required. Worker polling, stale timeout, and resource thresholds are configurable. Heavy concurrency is locked to `1`. Never place production credentials in this project.

## Quality and operations

```powershell
npm.cmd run db:migrate
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

Migrations are ordered SQL files in `packages/database/migrations` and applied through Drizzle. Page queries are bounded and expose basic elapsed timings on Dashboard, Sites, and Jobs.

## Resource model

The eventual host is a Hetzner CX23 (2 vCPU, 4 GB RAM, 40 GB disk) shared with an existing application. The SEO stack must not assume all host resources belong to it. Default container ceilings total 1.25 GB: PostgreSQL 512 MB, web 512 MB and worker 256 MB. The idle worker sleeps between queue checks; only one heavy job runs. See [docs/resource-model.md](docs/resource-model.md).

## Batch boundary

Production deployment is explicitly **not part of Batch 1**. No deployment, Hetzner connection, Git push, real GSC credentials, OpenAI calls, crawling or repository modification is implemented.
