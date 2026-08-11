CREATE TABLE IF NOT EXISTS ai_analysis_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
 job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
 reused_run_id uuid REFERENCES ai_analysis_runs(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'QUEUED',
 analysis_key text NOT NULL,
 evidence_hash text NOT NULL,
 opportunity_fingerprint text NOT NULL,
 prompt_version text NOT NULL,
 schema_version text NOT NULL,
 model text NOT NULL,
 reasoning_effort text NOT NULL,
 estimated_cost_micros integer NOT NULL DEFAULT 0,
 actual_cost_micros integer NOT NULL DEFAULT 0,
 input_tokens integer NOT NULL DEFAULT 0,
 cached_input_tokens integer NOT NULL DEFAULT 0,
 output_tokens integer NOT NULL DEFAULT 0,
 provider_request_id text,
 latency_ms integer,
 context_chars integer NOT NULL DEFAULT 0,
 failure_code text,
 failure_summary text,
 started_at timestamptz,
 finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_recommendations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 analysis_run_id uuid NOT NULL UNIQUE REFERENCES ai_analysis_runs(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
 verdict text NOT NULL,
 confidence text NOT NULL,
 summary text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS analysis_run_id uuid REFERENCES ai_analysis_runs(id) ON DELETE SET NULL;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'SUCCEEDED';

DO $$ BEGIN ALTER TABLE ai_analysis_runs ADD CONSTRAINT ai_analysis_status_check
 CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','REUSED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ai_analysis_runs ADD CONSTRAINT ai_analysis_cost_check
 CHECK (estimated_cost_micros>=0 AND actual_cost_micros>=0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ai_recommendations ADD CONSTRAINT ai_recommendation_verdict_check
 CHECK (verdict IN ('ACTIONABLE','INVESTIGATE','MONITOR','INSUFFICIENT_EVIDENCE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ai_recommendations ADD CONSTRAINT ai_recommendation_confidence_check
 CHECK (confidence IN ('HIGH','MEDIUM','LOW'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ai_analysis_opportunity_created_idx ON ai_analysis_runs(opportunity_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_analysis_site_created_idx ON ai_analysis_runs(site_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_analysis_reuse_idx ON ai_analysis_runs(analysis_key,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_analysis_status_idx ON ai_analysis_runs(status,created_at);
CREATE INDEX IF NOT EXISTS ai_recommendations_opportunity_idx ON ai_recommendations(opportunity_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_site_created_idx ON ai_usage(site_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_analysis_idx ON ai_usage(analysis_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_ai_analysis_per_opportunity_idx
 ON jobs((payload->>'opportunityId')) WHERE type='ANALYZE_OPPORTUNITY' AND status IN ('QUEUED','RUNNING');
