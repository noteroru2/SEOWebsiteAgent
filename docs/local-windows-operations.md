# Local Windows operations

The Local-first runtime uses two repository scripts and two Windows Scheduled Tasks. Neither script
connects to Production or invokes an AI/SERP provider.

## Startup

`scripts/local-start.ps1` waits up to five minutes for Docker Desktop, then runs `docker compose up
-d --no-build` from the fixed Local repository path. It waits for PostgreSQL, Web, and Worker health
and writes a dated log under `Documents\SEOWebsiteAgent-local-data\logs`. Repeated execution is
safe: Compose reuses already-running containers and the Scheduled Task ignores a second instance.

The `SEO Agent Local Startup` task runs for the current interactive Owner at logon after a 45-second
delay. Docker Desktop's standard start-at-login setting remains the mechanism that starts Docker.

## Database backup

`scripts/local-backup-postgres.ps1` dumps only the PostgreSQL service in this Local Compose project.
It writes a temporary SQL file, compresses to a `.partial` archive, validates the full gzip stream,
atomically renames the archive, and records SHA-256 in a sidecar and Local state file. Temporary files
are removed on failure.

Normal scheduled invocations skip before 11:00 and skip when a valid backup already exists for the
current Bangkok date. This makes the logon trigger a safe catch-up after 11:00 while the daily 11:00
trigger remains the normal path. `-Force` is reserved for an explicitly authorized manual backup.

An exclusive file lock prevents overlapping dumps. Retention is 30 days and matches only
`seo_agent_local_*.sql.gz` plus the corresponding hash sidecar. Backups, state, locks, and logs stay
outside the Git repository under `Documents\SEOWebsiteAgent-local-data`.

No shutdown task is installed. Never add `docker compose down -v` to Local automation because the
PostgreSQL volume is persistent.
