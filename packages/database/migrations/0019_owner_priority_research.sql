CREATE TABLE IF NOT EXISTS owner_research_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  query text NOT NULL,
  normalized_query text NOT NULL,
  research_type text NOT NULL CHECK (research_type='OWNER_PRIORITY_SEO'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','RESEARCHING','WAITING_FOR_EVIDENCE','READY_FOR_ANALYSIS',
    'ANALYSIS_COMPLETE','CLOSED','CANCELLED'
  )),
  priority text NOT NULL DEFAULT 'HIGH' CHECK (priority IN ('NORMAL','HIGH')),
  reason text NOT NULL CHECK (reason='OWNER_BUSINESS_PRIORITY'),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  owner_intent text NOT NULL,
  target_page text,
  primary_gsc_page text,
  repository_id uuid REFERENCES site_repositories(id) ON DELETE SET NULL,
  source_head_sha text,
  last_assessed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(query) BETWEEN 1 AND 200),
  CHECK (char_length(normalized_query) BETWEEN 1 AND 200),
  CHECK (char_length(requested_by) BETWEEN 1 AND 100),
  CHECK (char_length(owner_intent) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_research_cases_active_identity_idx
  ON owner_research_cases(site_id,normalized_query,research_type)
  WHERE status NOT IN ('CLOSED','CANCELLED');
CREATE INDEX IF NOT EXISTS owner_research_cases_site_status_idx
  ON owner_research_cases(site_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS owner_research_cases_opportunity_idx
  ON owner_research_cases(opportunity_id) WHERE opportunity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS owner_research_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  reason text NOT NULL CHECK (reason='OWNER_BUSINESS_PRIORITY'),
  owner_intent text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_research_requests_case_idx
  ON owner_research_requests(case_id,requested_at DESC);

CREATE TABLE IF NOT EXISTS owner_research_fact_links (
  case_id uuid NOT NULL REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES owner_facts(id) ON DELETE RESTRICT,
  fact_hash text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,fact_id)
);

CREATE TABLE IF NOT EXISTS owner_research_source_links (
  case_id uuid NOT NULL REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  mapping_id uuid NOT NULL REFERENCES source_route_mappings(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('PRIMARY_GSC_SELECTED','OWNER_INTENT_TARGET')),
  source_head_sha text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,mapping_id,role)
);

CREATE TABLE IF NOT EXISTS owner_research_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES owner_research_cases(id) ON DELETE CASCADE,
  finding_type text NOT NULL CHECK (finding_type IN (
    'PAGE_INTENT_MISMATCH','POTENTIAL_CANNIBALIZATION','TITLE_META_ALIGNMENT_GAP',
    'BUSINESS_PROCESS_GAP','INSUFFICIENT_BUSINESS_EVIDENCE'
  )),
  finding_status text NOT NULL CHECK (finding_status IN (
    'PRESENT','PRESENT_UNPROVEN_HARM','ABSENT','RESOLVED','UNKNOWN'
  )),
  summary text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id,finding_type)
);

ALTER TABLE evidence_requests
  ALTER COLUMN opportunity_id DROP NOT NULL;
ALTER TABLE evidence_requests
  ADD COLUMN IF NOT EXISTS owner_research_case_id uuid
    REFERENCES owner_research_cases(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS evidence_request_active_unique_idx;
CREATE UNIQUE INDEX evidence_request_active_opportunity_unique_idx
  ON evidence_requests(opportunity_id,type,requirement)
  WHERE opportunity_id IS NOT NULL AND status<>'SUPERSEDED';
CREATE UNIQUE INDEX evidence_request_active_research_unique_idx
  ON evidence_requests(owner_research_case_id,type,requirement)
  WHERE owner_research_case_id IS NOT NULL AND status<>'SUPERSEDED';
CREATE INDEX IF NOT EXISTS evidence_request_research_idx
  ON evidence_requests(owner_research_case_id,status)
  WHERE owner_research_case_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE evidence_requests ADD CONSTRAINT evidence_requests_exactly_one_subject_check
    CHECK (num_nonnulls(opportunity_id,owner_research_case_id)=1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
