ALTER TABLE site_repositories
  ADD COLUMN IF NOT EXISTS repository_type text NOT NULL DEFAULT 'LOCAL_GIT',
  ADD COLUMN IF NOT EXISTS expected_remote text,
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS head_sha text,
  ADD COLUMN IF NOT EXISTS current_branch text,
  ADD COLUMN IF NOT EXISTS origin_url text,
  ADD COLUMN IF NOT EXISTS worktree_clean boolean,
  ADD COLUMN IF NOT EXISTS tracked_file_count integer,
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz;

CREATE TABLE IF NOT EXISTS source_route_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES site_repositories(id) ON DELETE CASCADE,
  route_url text NOT NULL, route_path text NOT NULL, mapping_status text NOT NULL,
  primary_source_path text, related_source_paths jsonb NOT NULL DEFAULT '[]', repository_head_sha text NOT NULL,
  mapping_evidence jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS source_route_mapping_repo_route_idx ON source_route_mappings(repository_id,route_path);
CREATE INDEX IF NOT EXISTS source_route_mapping_site_status_idx ON source_route_mappings(site_id,mapping_status);

CREATE TABLE IF NOT EXISTS source_plan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES site_repositories(id) ON DELETE RESTRICT,
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL, reused_run_id uuid,
  status text NOT NULL DEFAULT 'RUNNING', model text NOT NULL, reasoning_effort text NOT NULL,
  prompt_version text NOT NULL, schema_version text NOT NULL, repository_head_sha text NOT NULL,
  source_evidence_hash text NOT NULL, source_context jsonb NOT NULL DEFAULT '{}', input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  actual_cost_micros integer NOT NULL DEFAULT 0, provider_request_id text, latency_ms integer,
  failure_code text, failure_summary text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_plan_runs_opportunity_idx ON source_plan_runs(opportunity_id,created_at);
CREATE INDEX IF NOT EXISTS source_plan_runs_reuse_idx ON source_plan_runs(source_evidence_hash,status);

CREATE TABLE IF NOT EXISTS source_change_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL UNIQUE REFERENCES source_plan_runs(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  verdict text NOT NULL, confidence text NOT NULL, batch5_reconciliation text NOT NULL, summary text NOT NULL,
  structured_output jsonb NOT NULL, status text NOT NULL DEFAULT 'READY_FOR_REVIEW', approved_at timestamptz,
  rejected_at timestamptz, stale_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_change_plans_status_idx ON source_change_plans(status,created_at);
CREATE INDEX IF NOT EXISTS source_change_plans_opportunity_idx ON source_change_plans(opportunity_id,created_at);

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS source_plan_run_id uuid REFERENCES source_plan_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_usage_source_plan_idx ON ai_usage(source_plan_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_source_refresh_per_site_idx ON jobs(site_id) WHERE type='REFRESH_SOURCE_REPOSITORY' AND status IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_source_plan_per_opportunity_idx ON jobs((payload->>'opportunityId')) WHERE type='GENERATE_SOURCE_CHANGE_PLAN' AND status IN ('QUEUED','RUNNING');
