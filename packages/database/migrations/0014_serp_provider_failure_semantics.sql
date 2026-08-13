ALTER TABLE serp_provider_configs
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

ALTER TABLE serp_api_captures
  ADD COLUMN IF NOT EXISTS failure_origin text CHECK (failure_origin IN ('PROVIDER','NETWORK','ADAPTER','REQUEST','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS failure_http_status integer,
  ADD COLUMN IF NOT EXISTS failure_provider_code text,
  ADD COLUMN IF NOT EXISTS failure_content_type text,
  ADD COLUMN IF NOT EXISTS failure_provider_status text,
  ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(failure_history) = 'array');

UPDATE serp_provider_configs
SET consecutive_failures = 1,
    cooldown_until = CASE
      WHEN last_error_category IN ('TEMPORARILY_UNAVAILABLE','NETWORK_TIMEOUT','PROVIDER_ERROR','UNKNOWN_FAILURE')
        THEN last_failure_at + interval '15 minutes'
      ELSE cooldown_until
    END
WHERE last_failure_at IS NOT NULL AND consecutive_failures = 0;

WITH latest_provider_failure AS (
  SELECT DISTINCT ON (e.job_id)
    e.job_id,
    e.created_at,
    e.detail->>'provider' provider,
    e.detail->>'category' category
  FROM job_events e
  WHERE e.event = 'SERP_API_PROVIDER_FAILED'
  ORDER BY e.job_id,e.created_at DESC,e.id DESC
), corrected AS (
  UPDATE serp_api_captures c
  SET status = 'FAILED',
      failure_code = f.category,
      failure_summary = CASE f.category
        WHEN 'TEMPORARILY_UNAVAILABLE' THEN 'Provider temporarily unavailable; owner action required'
        WHEN 'NETWORK_TIMEOUT' THEN 'Provider request timed out; owner action required'
        ELSE 'Provider request failed; owner action required'
      END,
      failure_origin = 'UNKNOWN',
      failure_history = c.failure_history || jsonb_build_array(jsonb_build_object(
        'provider',f.provider,
        'category',f.category,
        'origin','UNKNOWN',
        'occurredAt',f.created_at,
        'diagnosticsRetained',false,
        'restoredFrom','SERP_API_PROVIDER_FAILED'
      )),
      updated_at = now()
  FROM latest_provider_failure f
  WHERE c.job_id = f.job_id
    AND c.status = 'CAPABILITY_MISMATCH'
    AND c.failure_code = 'NO_FREE_PROVIDER'
    AND c.normalized_result IS NULL
  RETURNING c.job_id
)
UPDATE jobs j
SET status = 'FAILED',
    failure_code = 'SERP_OWNER_ACTION_REQUIRED',
    failure_summary = 'Provider unavailable; owner browser capture required',
    updated_at = now()
WHERE j.id IN (SELECT job_id FROM corrected)
  AND j.status = 'SUCCEEDED'
  AND j.result->>'fallback' = 'OWNER_BROWSER';

INSERT INTO job_events(job_id,event,detail)
SELECT j.id,'FAILURE_SEMANTICS_CORRECTED',jsonb_build_object(
  'previousStatus','SUCCEEDED',
  'terminalMeaning','OWNER_ACTION_REQUIRED',
  'fallback','OWNER_BROWSER'
)
FROM jobs j
WHERE j.type = 'FETCH_SERP_API'
  AND j.status = 'FAILED'
  AND j.failure_code = 'SERP_OWNER_ACTION_REQUIRED'
  AND j.result->>'fallback' = 'OWNER_BROWSER'
  AND NOT EXISTS (
    SELECT 1 FROM job_events e
    WHERE e.job_id = j.id AND e.event = 'FAILURE_SEMANTICS_CORRECTED'
  );
