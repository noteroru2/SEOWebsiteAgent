#!/bin/sh
set -eu

backup_dir=${SEO_AGENT_BACKUP_DIR:-/root/backups/seo_agent}
retention_days=${SEO_AGENT_BACKUP_RETENTION_DAYS:-30}
container=${SEO_AGENT_POSTGRES_CONTAINER:-app-postgres-1}
database=${SEO_AGENT_POSTGRES_DATABASE:-seo_agent}
user=${SEO_AGENT_POSTGRES_USER:-seo_agent}
timestamp=$(date -u +%Y-%m-%dT%H%M%SZ)
archive="$backup_dir/seo_agent_$timestamp.sql.gz"
temporary_dump="$backup_dir/.seo_agent_$timestamp.sql"
temporary_archive="$archive.tmp"

cleanup() {
  rm -f "$temporary_dump" "$temporary_archive"
}

umask 077
mkdir -p "$backup_dir"
trap cleanup EXIT HUP INT TERM
docker exec "$container" pg_dump -U "$user" "$database" > "$temporary_dump"
gzip -c "$temporary_dump" > "$temporary_archive"
gzip -t "$temporary_archive"
mv "$temporary_archive" "$archive"
rm -f "$temporary_dump"
trap - EXIT HUP INT TERM
find "$backup_dir" -maxdepth 1 -type f -name 'seo_agent_*.sql.gz' -mtime "+$retention_days" -delete
printf 'Backup completed: %s\n' "$archive"
