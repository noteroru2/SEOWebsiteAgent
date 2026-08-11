CREATE TABLE IF NOT EXISTS opportunity_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
 crawl_run_id uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
 gsc_sync_reference uuid REFERENCES gsc_sync_runs(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'RUNNING',
 candidates_generated integer NOT NULL DEFAULT 0,
 opportunities_created integer NOT NULL DEFAULT 0,
 opportunities_updated integer NOT NULL DEFAULT 0,
 opportunities_resolved integer NOT NULL DEFAULT 0,
 opportunities_suppressed integer NOT NULL DEFAULT 0,
 suppression_counts jsonb NOT NULL DEFAULT '{}',
 duration_ms integer,
 engine_version text NOT NULL,
 failure_code text,
 failure_summary text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'SITE';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS query text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS priority_label text NOT NULL DEFAULT 'LOW';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'LOW';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS score_components jsonb NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS generation_run_id uuid REFERENCES opportunity_runs(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS first_detected_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS last_detected_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS missing_run_count integer NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

UPDATE opportunities SET fingerprint=encode(digest(id::text,'sha256'),'hex') WHERE fingerprint IS NULL;
ALTER TABLE opportunities ALTER COLUMN fingerprint SET NOT NULL;

DO $$ BEGIN ALTER TABLE opportunities ADD CONSTRAINT opportunities_score_check CHECK (score BETWEEN 0 AND 100); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE opportunities ADD CONSTRAINT opportunities_status_check CHECK (status IN ('OPEN','MONITOR','RESOLVED','DISMISSED')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE opportunities ADD CONSTRAINT opportunities_priority_label_check CHECK (priority_label IN ('HIGH','MEDIUM','LOW')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE opportunities ADD CONSTRAINT opportunities_confidence_check CHECK (confidence IN ('HIGH','MEDIUM','LOW')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS opportunities_fingerprint_unique_idx ON opportunities(site_id,engine_version,fingerprint);
CREATE INDEX IF NOT EXISTS opportunities_site_status_score_idx ON opportunities(site_id,status,score DESC);
CREATE INDEX IF NOT EXISTS opportunities_site_priority_idx ON opportunities(site_id,priority_label,score DESC);
CREATE INDEX IF NOT EXISTS opportunities_site_kind_idx ON opportunities(site_id,kind,score DESC);
CREATE INDEX IF NOT EXISTS opportunities_last_detected_idx ON opportunities(site_id,last_detected_at DESC);
CREATE INDEX IF NOT EXISTS opportunity_runs_site_created_idx ON opportunity_runs(site_id,created_at DESC);
CREATE INDEX IF NOT EXISTS opportunity_runs_status_idx ON opportunity_runs(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_opportunity_generation_per_site_idx ON jobs(site_id) WHERE type='GENERATE_OPPORTUNITIES' AND status IN ('QUEUED','RUNNING');
