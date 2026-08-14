ALTER TABLE source_plan_runs
  ALTER COLUMN opportunity_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS owner_research_case_id uuid
    REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject_type text NOT NULL DEFAULT 'OPPORTUNITY';

ALTER TABLE source_change_plans
  ALTER COLUMN opportunity_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS owner_research_case_id uuid
    REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject_type text NOT NULL DEFAULT 'OPPORTUNITY';

DO $$ BEGIN
  ALTER TABLE source_plan_runs ADD CONSTRAINT source_plan_runs_subject_type_check
    CHECK (subject_type IN ('OPPORTUNITY','OWNER_RESEARCH_CASE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE source_plan_runs ADD CONSTRAINT source_plan_runs_exactly_one_subject_check
    CHECK (
      num_nonnulls(opportunity_id,owner_research_case_id)=1
      AND subject_type=CASE WHEN opportunity_id IS NOT NULL THEN 'OPPORTUNITY' ELSE 'OWNER_RESEARCH_CASE' END
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE source_change_plans ADD CONSTRAINT source_change_plans_subject_type_check
    CHECK (subject_type IN ('OPPORTUNITY','OWNER_RESEARCH_CASE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE source_change_plans ADD CONSTRAINT source_change_plans_exactly_one_subject_check
    CHECK (
      num_nonnulls(opportunity_id,owner_research_case_id)=1
      AND subject_type=CASE WHEN opportunity_id IS NOT NULL THEN 'OPPORTUNITY' ELSE 'OWNER_RESEARCH_CASE' END
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS source_plan_runs_owner_research_idx
  ON source_plan_runs(owner_research_case_id,created_at DESC)
  WHERE owner_research_case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_change_plans_owner_research_idx
  ON source_change_plans(owner_research_case_id,created_at DESC)
  WHERE owner_research_case_id IS NOT NULL;

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS owner_research_case_id uuid
  REFERENCES owner_research_cases(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_usage_owner_research_idx
  ON ai_usage(owner_research_case_id,created_at DESC)
  WHERE owner_research_case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS owner_research_ai_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  authorization_ref text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'OWNER_RESEARCH_V3'
    CHECK (scope='OWNER_RESEARCH_V3'),
  status text NOT NULL DEFAULT 'AUTHORIZED'
    CHECK (status IN ('AUTHORIZED','CONSUMED','CANCELLED')),
  authorized_by text NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  run_id uuid UNIQUE REFERENCES source_plan_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_research_ai_authorizations_case_idx
  ON owner_research_ai_authorizations(case_id,status,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_source_plan_per_research_case_idx
  ON jobs((payload->>'ownerResearchCaseId'))
  WHERE type='GENERATE_SOURCE_CHANGE_PLAN'
    AND status IN ('QUEUED','RUNNING')
    AND payload ? 'ownerResearchCaseId';
