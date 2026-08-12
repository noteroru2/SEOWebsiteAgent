CREATE TABLE IF NOT EXISTS owner_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  value_json jsonb NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('BUSINESS_WIDE','SERVICE','PRODUCT_CATEGORY','GEOGRAPHY','SERVICE_GEOGRAPHY','QUERY')),
  scope_key text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','EXPIRED')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  review_after timestamptz,
  source_evidence_item_id uuid NOT NULL REFERENCES evidence_items(id) ON DELETE RESTRICT,
  confirmed_by text NOT NULL DEFAULT 'OWNER',
  superseded_at timestamptz,
  superseded_by uuid,
  fact_hash text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_facts_site_scope_idx ON owner_facts(site_id,fact_key,scope_type,scope_key);

CREATE TABLE IF NOT EXISTS serp_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES evidence_requests(id) ON DELETE CASCADE,
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CAPTURING','CAPTURED','CAPTURE_BLOCKED','FAILED','CONFIRMED','DISCARDED')),
  query text NOT NULL,
  target_domain text NOT NULL,
  device_provenance text NOT NULL CHECK (device_provenance IN ('EMULATED_DESKTOP','EMULATED_MOBILE')),
  requested_location_label text NOT NULL,
  requested_geolocation jsonb,
  timezone text NOT NULL,
  google_displayed_location text,
  capture_network_context text,
  machine_capture jsonb,
  owner_confirmed_value jsonb,
  corrected boolean NOT NULL DEFAULT false,
  screenshot_path text,
  screenshot_sha256 text,
  parser_version text,
  position_extraction_version text,
  captured_at timestamptz,
  confirmed_at timestamptz,
  discarded_at timestamptz,
  failure_code text,
  failure_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS serp_captures_request_idx ON serp_captures(request_id,created_at);
CREATE INDEX IF NOT EXISTS serp_captures_status_idx ON serp_captures(status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_serp_capture_per_request_idx
  ON jobs ((payload->>'requestId'))
  WHERE type='CAPTURE_SERP' AND status IN ('QUEUED','RUNNING');
