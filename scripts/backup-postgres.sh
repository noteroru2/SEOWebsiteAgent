#!/bin/sh
set -eu

backup_dir=${SEO_AGENT_BACKUP_DIR:-/root/backups/seo_agent}
retention_days=${SEO_AGENT_BACKUP_RETENTION_DAYS:-30}
container=${SEO_AGENT_POSTGRES_CONTAINER:-app-postgres-1}
database=${SEO_AGENT_POSTGRES_DATABASE:-seo_agent}
user=${SEO_AGENT_POSTGRES_USER:-seo_agent}
timestamp=$(date -u +%Y-%m-%dT%H%M%SZ)
archive="$backup_dir/seo_agent_$timestamp.sql.gz"
temporary="$archive.tmp"

umask 077
mkdir -p "$backup_dir"
docker exec "$container" pg_dump -U "$user" "$database" | gzip > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$archive"
find "$backup_dir" -maxdepth 1 -type f -name 'seo_agent_*.sql.gz' -mtime "+$retention_days" -delete
printf 'Backup completed: %s\n' "$archive"
