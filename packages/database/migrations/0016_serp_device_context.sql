DROP INDEX IF EXISTS jobs_one_serp_api_per_request_idx;

CREATE UNIQUE INDEX jobs_one_serp_api_per_request_device_idx
  ON jobs ((payload->>'requestId'),(payload->>'device'))
  WHERE type='FETCH_SERP_API' AND status IN ('QUEUED','RUNNING');
