CREATE TABLE IF NOT EXISTS serp_provider_configs (
  provider text PRIMARY KEY CHECK (provider IN ('SERPAPI','SERPSTACK','SERPER')),
  enabled boolean NOT NULL DEFAULT false,
  billing_mode text NOT NULL DEFAULT 'FREE_ONLY' CHECK (billing_mode='FREE_ONLY'),
  allowance_type text NOT NULL CHECK (allowance_type IN ('MONTHLY','CREDIT_POOL')),
  configured_allowance integer NOT NULL CHECK (configured_allowance>=0),
  reset_policy text NOT NULL DEFAULT 'EXPLICIT' CHECK (reset_policy IN ('EXPLICIT','OWNER_CONFIGURED')),
  priority integer NOT NULL,
  capabilities jsonb NOT NULL,
  health text NOT NULL DEFAULT 'AVAILABLE' CHECK (health IN ('AVAILABLE','NOT_CONFIGURED','FREE_QUOTA_EXHAUSTED','RATE_LIMITED','AUTH_FAILED','TEMPORARILY_UNAVAILABLE','CAPABILITY_MISMATCH')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO serp_provider_configs(provider,enabled,allowance_type,configured_allowance,priority,capabilities)
VALUES
 ('SERPAPI',false,'MONTHLY',250,10,'{"supportsCountry":true,"supportsCity":true,"supportsCoordinates":true,"supportsDesktop":true,"supportsMobile":true,"supportsTablet":true,"supportsOrganicResults":true,"supportsAds":true,"supportsAiOverview":true,"supportsMapPack":true,"supportsPaa":true,"supportsShopping":true,"supportsTitle":true,"supportsSnippet":true,"supportsResolvedUrl":true,"supportsPagination":true,"locationPrecision":"COORDINATE"}'),
 ('SERPSTACK',false,'MONTHLY',100,20,'{"supportsCountry":true,"supportsCity":true,"supportsCoordinates":false,"supportsDesktop":true,"supportsMobile":true,"supportsTablet":true,"supportsOrganicResults":true,"supportsAds":true,"supportsAiOverview":false,"supportsMapPack":true,"supportsPaa":true,"supportsShopping":true,"supportsTitle":true,"supportsSnippet":true,"supportsResolvedUrl":true,"supportsPagination":true,"locationPrecision":"CITY"}'),
 ('SERPER',false,'CREDIT_POOL',2500,30,'{"supportsCountry":true,"supportsCity":false,"supportsCoordinates":false,"supportsDesktop":true,"supportsMobile":false,"supportsTablet":false,"supportsOrganicResults":true,"supportsAds":true,"supportsAiOverview":false,"supportsMapPack":true,"supportsPaa":true,"supportsShopping":true,"supportsTitle":true,"supportsSnippet":true,"supportsResolvedUrl":true,"supportsPagination":true,"locationPrecision":"COUNTRY"}')
ON CONFLICT(provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS serp_provider_usage_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES serp_provider_configs(provider) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz,
  configured_allowance integer NOT NULL CHECK (configured_allowance>=0),
  used integer NOT NULL DEFAULT 0 CHECK (used>=0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved>=0),
  owner_confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,period_start),
  CHECK (used+reserved<=configured_allowance)
);
CREATE UNIQUE INDEX IF NOT EXISTS serp_provider_one_active_period_idx
  ON serp_provider_usage_periods(provider) WHERE period_end IS NULL;

CREATE TABLE IF NOT EXISTS serp_api_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES evidence_requests(id) ON DELETE CASCADE,
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  provider text REFERENCES serp_provider_configs(provider) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','FETCHING','SUCCEEDED','PENDING_REVIEW','ACCEPTED','REJECTED','FREE_QUOTA_EXHAUSTED','CAPABILITY_MISMATCH','AUTH_FAILED','RATE_LIMITED','FAILED')),
  request_fingerprint text NOT NULL,
  query text NOT NULL,
  requested_location text NOT NULL,
  required_precision text NOT NULL CHECK (required_precision IN ('COORDINATE','CITY','REGION','COUNTRY','UNKNOWN')),
  device text NOT NULL CHECK (device IN ('DESKTOP','MOBILE','TABLET')),
  target_domain text NOT NULL,
  max_organic_results integer NOT NULL DEFAULT 20 CHECK (max_organic_results BETWEEN 1 AND 30),
  normalized_result jsonb,
  provider_request_id text,
  provider_location_used text,
  location_precision text,
  target_found boolean,
  target_organic_position integer,
  target_url text,
  target_title text,
  target_snippet text,
  evidence_quality text,
  conflict boolean NOT NULL DEFAULT false,
  captured_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  failure_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS serp_api_captures_request_idx ON serp_api_captures(request_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS serp_api_one_active_request_idx
  ON serp_api_captures(request_fingerprint) WHERE status IN ('QUEUED','FETCHING');
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_serp_api_per_request_idx
  ON jobs ((payload->>'requestId')) WHERE type='FETCH_SERP_API' AND status IN ('QUEUED','RUNNING');

CREATE TABLE IF NOT EXISTS serp_provider_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES serp_provider_configs(provider) ON DELETE CASCADE,
  usage_period_id uuid NOT NULL REFERENCES serp_provider_usage_periods(id) ON DELETE RESTRICT,
  capture_id uuid NOT NULL REFERENCES serp_api_captures(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(capture_id,provider)
);
