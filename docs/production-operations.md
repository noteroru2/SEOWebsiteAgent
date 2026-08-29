# Production operations

Production must fail closed. A successful HTTP response from the web container is not sufficient
evidence that the worker or daily scheduler is healthy.

## Required production configuration

- Set `APP_GIT_SHA` to the exact 40-character commit being built.
- Set `OWNER_AUTH_REQUIRED=true` and provide unique `OWNER_AUTH_USERNAME` and
  `OWNER_AUTH_PASSWORD` values through the server-only environment file.
- Set `SCHEDULER_ENABLED=true` only after confirming there are no queued or running executable
  jobs. The scheduler creates deterministic `PRODUCTION_OPPORTUNITY_WATCH` jobs only; it does not
  call OpenAI or a SERP provider.
- Keep `EXPECTED_MIGRATION_COUNT` aligned with the migration journal.
- Keep the source repository mount read-only.

The detailed `/api/health` endpoint reports database, worker heartbeat, scheduler heartbeat, queue,
migration count, and runtime SHA. `/api/health?scope=live` is reserved for the web container liveness
check and only proves that the web process can reach PostgreSQL.

## Daily scheduler

The worker checks due sites at a bounded interval. Each active site becomes due at 09:15
Asia/Bangkok plus its configured stagger offset. A PostgreSQL advisory lock serializes scheduler
ticks, and existing watch jobs/runs for the Bangkok calendar date prevent duplicate daily work.
The scheduler is opt-in and defaults to disabled.

## Database backup

Run the tracked backup script from root cron so date formatting is not embedded in crontab:

```cron
0 3 * * * /bin/sh /opt/seo-agent/app/scripts/backup-postgres.sh >> /var/log/seo-agent-backup.log 2>&1
```

The script writes a UTC timestamped temporary archive, verifies it with `gzip -t`, atomically moves
it into place, and retains 30 days by default. A restore drill remains required before claiming that
backups are operationally verified.

## Deployment gate

Before recreating containers, record the current Git SHA, image IDs, queue state, migration count,
and latest valid backup. Build with the authorized SHA, apply migrations, recreate only the required
services, and verify the detailed health endpoint. Do not enable the scheduler until queue safety has
been checked. Roll back to the recorded image IDs if readiness fails.
