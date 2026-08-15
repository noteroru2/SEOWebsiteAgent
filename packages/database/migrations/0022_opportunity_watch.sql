CREATE TABLE IF NOT EXISTS golden_path_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'QUALIFIED',
  fingerprint text NOT NULL,
  qualification_version text NOT NULL DEFAULT 'v1',
  selection_reason text NOT NULL,
  gsc_run_id uuid REFERENCES gsc_sync_runs(id) ON DELETE SET NULL,
  analysis_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_head text NOT NULL,
  target_url text NOT NULL,
  source_file text,
  risk text NOT NULL DEFAULT 'LOW',
  sample_sufficiency text NOT NULL,
  last_evaluated_at timestamp with time zone NOT NULL DEFAULT now(),
  owner_seen_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS golden_path_candidates_site_status_idx ON golden_path_candidates(site_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS golden_path_candidates_fingerprint_idx ON golden_path_candidates(site_id, fingerprint);

CREATE TABLE IF NOT EXISTS opportunity_watch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'SUCCESS',
  gsc_action text NOT NULL,
  crawl_action text NOT NULL,
  opportunity_action text NOT NULL,
  active_opportunities_count integer NOT NULL DEFAULT 0,
  qualified_candidates_count integer NOT NULL DEFAULT 0,
  new_candidates_count integer NOT NULL DEFAULT 0,
  unchanged_candidates_count integer NOT NULL DEFAULT 0,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunity_watch_runs_site_idx ON opportunity_watch_runs(site_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_watch_per_site_idx
  ON jobs(site_id)
  WHERE type = 'PRODUCTION_OPPORTUNITY_WATCH' AND status IN ('QUEUED', 'RUNNING');
