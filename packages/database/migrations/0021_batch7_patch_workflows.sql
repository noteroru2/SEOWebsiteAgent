CREATE TABLE IF NOT EXISTS patch_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  owner_research_case_id uuid REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  source_change_plan_id uuid NOT NULL REFERENCES source_change_plans(id) ON DELETE CASCADE,
  source_head_sha text NOT NULL,
  status text NOT NULL DEFAULT 'REVIEW_REQUIRED',
  risk text NOT NULL DEFAULT 'MEDIUM',
  target_route_path text NOT NULL,
  target_source_path text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT patch_workflows_subject_check CHECK (
    (subject_type = 'OPPORTUNITY' AND opportunity_id IS NOT NULL AND owner_research_case_id IS NULL) OR
    (subject_type = 'OWNER_RESEARCH_CASE' AND owner_research_case_id IS NOT NULL AND opportunity_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS patch_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  source_change_plan_id uuid NOT NULL REFERENCES source_change_plans(id) ON DELETE CASCADE,
  base_source_head_sha text NOT NULL,
  target_source_path text NOT NULL,
  preview_hash text NOT NULL,
  unified_diff text NOT NULL,
  change_summary jsonb NOT NULL,
  claim_traceability jsonb NOT NULL,
  forbidden_claims_findings jsonb NOT NULL,
  preservation_checks jsonb NOT NULL,
  stale boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  preview_id uuid NOT NULL REFERENCES patch_previews(id) ON DELETE CASCADE,
  preview_hash text NOT NULL,
  approval_type text NOT NULL,
  actor text NOT NULL,
  decision text NOT NULL,
  reason text,
  target_commit_sha text,
  remote_base_sha text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_workspace_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  preview_id uuid NOT NULL REFERENCES patch_previews(id) ON DELETE CASCADE,
  workspace_path text NOT NULL,
  base_commit_sha text NOT NULL,
  applied_commit_sha text,
  status text NOT NULL DEFAULT 'CREATED',
  error_message text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  workspace_run_id uuid REFERENCES patch_workspace_runs(id) ON DELETE SET NULL,
  check_name text NOT NULL,
  status text NOT NULL,
  is_mandatory boolean NOT NULL DEFAULT true,
  summary text NOT NULL,
  diagnostics_json jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  release_authorization_id uuid NOT NULL REFERENCES patch_approvals(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  repository_url text NOT NULL,
  target_branch text NOT NULL DEFAULT 'main',
  remote_base_sha text NOT NULL,
  release_commit_sha text NOT NULL,
  push_type text NOT NULL DEFAULT 'FAST_FORWARD',
  deployment_mechanism text NOT NULL DEFAULT 'VERCEL_GIT_INTEGRATION',
  deployment_id text,
  deployment_sha text,
  status text NOT NULL DEFAULT 'RELEASED',
  released_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_rollbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  target_release_id uuid NOT NULL REFERENCES patch_releases(id) ON DELETE CASCADE,
  production_commit_sha text NOT NULL,
  previous_good_commit_sha text NOT NULL,
  reason text NOT NULL,
  authorization_id uuid NOT NULL REFERENCES patch_approvals(id) ON DELETE CASCADE,
  rollback_commit_sha text,
  status text NOT NULL DEFAULT 'REQUESTED',
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_workflow_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES patch_workflows(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor text NOT NULL,
  old_state text,
  new_state text,
  summary text NOT NULL,
  details_json jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS patch_workflows_status_idx ON patch_workflows(status, created_at);
CREATE INDEX IF NOT EXISTS patch_workflows_site_idx ON patch_workflows(site_id, created_at);
CREATE INDEX IF NOT EXISTS patch_previews_workflow_idx ON patch_previews(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS patch_approvals_workflow_idx ON patch_approvals(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS patch_validations_workflow_idx ON patch_validations(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS patch_audit_workflow_idx ON patch_workflow_audit_events(workflow_id, created_at);
