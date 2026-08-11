CREATE TABLE IF NOT EXISTS gsc_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE, encrypted_refresh_token text, encrypted_access_token text,
 access_token_expires_at timestamptz, scope text NOT NULL, status text NOT NULL DEFAULT 'CONNECTED',
 last_error_code text, disconnected_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gsc_oauth_states (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 state_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gsc_oauth_states_expiry_idx ON gsc_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS gsc_properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid REFERENCES gsc_connections(id) ON DELETE SET NULL,
 property_uri text NOT NULL, property_type text NOT NULL, permission_level text NOT NULL,
 last_discovered_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gsc_properties_connection_idx ON gsc_properties(connection_id);
ALTER TABLE gsc_properties DROP CONSTRAINT IF EXISTS gsc_properties_property_uri_key;
CREATE UNIQUE INDEX IF NOT EXISTS gsc_properties_connection_uri_idx ON gsc_properties(connection_id,property_uri);
CREATE TABLE IF NOT EXISTS site_gsc_properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE RESTRICT, connection_id uuid NOT NULL REFERENCES gsc_connections(id) ON DELETE RESTRICT,
 search_type text NOT NULL DEFAULT 'web', sync_enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_gsc_properties_site_idx ON site_gsc_properties(site_id);
CREATE INDEX IF NOT EXISTS site_gsc_properties_property_idx ON site_gsc_properties(property_id);
CREATE TABLE IF NOT EXISTS gsc_sync_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE RESTRICT, job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 mode text NOT NULL, start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL DEFAULT 'RUNNING',
 api_requests integer NOT NULL DEFAULT 0, rows_received integer NOT NULL DEFAULT 0, rows_inserted integer NOT NULL DEFAULT 0,
 rows_updated integer NOT NULL DEFAULT 0, coverage_status text NOT NULL DEFAULT 'COMPLETE_AS_RETURNED', failure_code text, failure_summary text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gsc_sync_runs_site_idx ON gsc_sync_runs(site_id,started_at DESC);
CREATE INDEX IF NOT EXISTS gsc_sync_runs_status_idx ON gsc_sync_runs(status,started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_gsc_sync_per_site_idx ON jobs(site_id) WHERE type='GSC_SYNC' AND status IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_gsc_running_idx ON jobs(type) WHERE type='GSC_SYNC' AND status='RUNNING';

CREATE TABLE IF NOT EXISTS gsc_daily_site_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, search_type text NOT NULL DEFAULT 'web', metric_date date NOT NULL, clicks bigint NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, ctr double precision NOT NULL DEFAULT 0, position double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gsc_daily_site_unique_idx ON gsc_daily_site_metrics(site_id,property_id,search_type,metric_date);
CREATE INDEX IF NOT EXISTS gsc_daily_site_date_idx ON gsc_daily_site_metrics(site_id,metric_date DESC);
CREATE TABLE IF NOT EXISTS gsc_query_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, search_type text NOT NULL DEFAULT 'web', metric_date date NOT NULL, query text NOT NULL, clicks bigint NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, ctr double precision NOT NULL DEFAULT 0, position double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gsc_query_unique_idx ON gsc_query_metrics(site_id,property_id,search_type,metric_date,query);
CREATE INDEX IF NOT EXISTS gsc_query_lookup_idx ON gsc_query_metrics(site_id,query,metric_date DESC);
CREATE TABLE IF NOT EXISTS gsc_page_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, search_type text NOT NULL DEFAULT 'web', metric_date date NOT NULL, page text NOT NULL, clicks bigint NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, ctr double precision NOT NULL DEFAULT 0, position double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gsc_page_unique_idx ON gsc_page_metrics(site_id,property_id,search_type,metric_date,page);
CREATE INDEX IF NOT EXISTS gsc_page_lookup_idx ON gsc_page_metrics(site_id,page,metric_date DESC);
CREATE TABLE IF NOT EXISTS gsc_query_page_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, search_type text NOT NULL DEFAULT 'web', metric_date date NOT NULL, query text NOT NULL, page text NOT NULL, clicks bigint NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, ctr double precision NOT NULL DEFAULT 0, position double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gsc_query_page_unique_idx ON gsc_query_page_metrics(site_id,property_id,search_type,metric_date,query,page);
CREATE INDEX IF NOT EXISTS gsc_query_page_lookup_idx ON gsc_query_page_metrics(site_id,query,page,metric_date DESC);

CREATE TABLE IF NOT EXISTS gsc_sync_summaries (site_id uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, last_sync_run_id uuid REFERENCES gsc_sync_runs(id) ON DELETE SET NULL, last_finalized_date date, current_metrics jsonb NOT NULL DEFAULT '{}', previous_metrics jsonb NOT NULL DEFAULT '{}', deltas jsonb NOT NULL DEFAULT '{}', top_pages_count integer NOT NULL DEFAULT 0, top_queries_count integer NOT NULL DEFAULT 0, rows_stored bigint NOT NULL DEFAULT 0, coverage_status text NOT NULL DEFAULT 'COMPLETE_AS_RETURNED', latest_status text NOT NULL DEFAULT 'SUCCEEDED', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gsc_page_crawl_mappings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, property_id uuid NOT NULL REFERENCES gsc_properties(id) ON DELETE CASCADE, gsc_page text NOT NULL, crawl_run_id uuid REFERENCES crawl_runs(id) ON DELETE SET NULL, crawl_page_id uuid REFERENCES crawl_pages(id) ON DELETE SET NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gsc_page_crawl_mapping_unique_idx ON gsc_page_crawl_mappings(site_id,property_id,gsc_page);
CREATE INDEX IF NOT EXISTS gsc_page_crawl_mapping_reason_idx ON gsc_page_crawl_mappings(site_id,reason);
