# Local Manual Command Center

The Local-first Command Center lets the owner enqueue Opportunity Watch work immediately without
waiting for the daily scheduler. It is disabled by default and must be enabled explicitly with
`LOCAL_MANUAL_COMMANDS_ENABLED=true` in the local environment.

## Execution boundary

- `POST /api/jobs/run-now` accepts only `{ "mode": "ALL" }` or
  `{ "mode": "SITE", "siteId": "<uuid>" }`.
- The web request only validates and enqueues. Opportunity Watch always executes in the Worker.
- Manual jobs use `commandSource: MANUAL_OWNER`; they never impersonate `DAILY_SCHEDULER`.
- Manual commands do not authorize OpenAI, SERP providers, patch execution, source writes, or
  deployment. Opportunity Watch remains deterministic and read-only.

## Safety and idempotency

Manual enqueue and the daily scheduler share the same PostgreSQL advisory transaction lock. The
existing partial unique index also permits only one queued/running Opportunity Watch per site.
Double-clicks, browser retries, multiple tabs, and scheduler/manual races therefore resolve to one
active job. Cancelled migration jobs do not block an explicit manual command. A successful manual
job counts as that site's watch for the Bangkok calendar date and prevents a redundant scheduled
job later that day.

Eligible sites must be active, use a supported watch mode, have `source_status=CURRENT`, and have an
enabled, clean, resolved source repository. The API fails closed when the Worker heartbeat is stale,
the executor resource guard is blocked, or no site is eligible.

## Runtime source of truth

Worker heartbeats persist Worker SHA, executor resource status, and the scheduler's enabled state,
daily time, and timezone. Scheduler tick events persist eligibility, due count, and enqueue count.
The Dashboard reads those database events instead of assuming the Web process environment describes
the Worker. Web and Worker SHAs are shown separately; a mismatch is labeled `MIXED_RUNTIME`.

## Audit and progress

Each command receives a UUID run ID. `MANUAL_RUN_REQUESTED` and `MANUAL_RUN_ENQUEUED` system events,
plus job events and the job payload, preserve source and identity. `GET /api/jobs/run-now?runId=...`
returns bounded progress for that run: queued, running, completed, failed, and cancelled counts.

The local Web and PostgreSQL ports remain bound to `127.0.0.1`. Enabling this feature does not change
network exposure or owner authentication policy.
