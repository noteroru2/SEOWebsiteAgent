ALTER TABLE serp_captures DROP CONSTRAINT IF EXISTS serp_captures_device_provenance_check;
ALTER TABLE serp_captures ADD CONSTRAINT serp_captures_device_provenance_check
  CHECK (device_provenance IN (
    'EMULATED_DESKTOP','EMULATED_MOBILE',
    'REAL_DESKTOP_BROWSER','REAL_MOBILE_BROWSER','UNKNOWN_REAL_BROWSER'
  ));

CREATE TABLE IF NOT EXISTS browser_capture_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES evidence_requests(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expected_query text NOT NULL,
  target_domain text NOT NULL,
  owner_declared_location text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS browser_capture_tokens_request_idx
  ON browser_capture_tokens(request_id,created_at DESC);
