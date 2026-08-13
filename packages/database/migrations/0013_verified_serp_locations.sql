CREATE TABLE IF NOT EXISTS serp_location_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  owner_label text NOT NULL,
  provider text NOT NULL REFERENCES serp_provider_configs(provider) ON DELETE RESTRICT,
  canonical_location text NOT NULL,
  provider_location_id text NOT NULL,
  precision text NOT NULL CHECK (precision IN ('COORDINATE','CITY','REGION','COUNTRY')),
  country_code text NOT NULL CHECK (country_code ~ '^[a-z]{2}$'),
  timezone text NOT NULL,
  verified_at timestamptz NOT NULL,
  verification_source text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,provider,provider_location_id)
);

ALTER TABLE serp_api_captures
  ADD COLUMN IF NOT EXISTS location_profile_id uuid REFERENCES serp_location_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS requested_location_label text,
  ADD COLUMN IF NOT EXISTS canonical_provider_location text,
  ADD COLUMN IF NOT EXISTS provider_location_id text,
  ADD COLUMN IF NOT EXISTS verified_precision text,
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS location_timezone text,
  ADD COLUMN IF NOT EXISTS location_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_verification_source text;

INSERT INTO serp_location_profiles(
  site_id,owner_label,provider,canonical_location,provider_location_id,precision,country_code,
  timezone,verified_at,verification_source,status
)
SELECT id,'Ubon Ratchathani, Thailand','SERPAPI',
  'Ubon Ratchathani,Ubon Ratchathani,Thailand','5b18bb955f59e41ee7212759','CITY','th',
  'Asia/Bangkok','2026-08-13T00:00:00Z','SERPAPI_LOCATIONS_API','ACTIVE'
FROM sites
WHERE lower(regexp_replace(url,'^https?://(www\.)?([^/]+).*$','\2'))='amphon.co.th'
ON CONFLICT(site_id,provider,provider_location_id) DO NOTHING;
