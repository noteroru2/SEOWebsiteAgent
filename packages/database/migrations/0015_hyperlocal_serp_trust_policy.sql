ALTER TABLE serp_api_captures
  DROP CONSTRAINT IF EXISTS serp_api_captures_status_check;

ALTER TABLE serp_api_captures
  ADD CONSTRAINT serp_api_captures_status_check CHECK (status IN (
    'QUEUED','FETCHING','SUCCEEDED','PENDING_REVIEW','ACCEPTED','REJECTED',
    'REJECTED_FOR_TARGET_CONTEXT','FREE_QUOTA_EXHAUSTED','CAPABILITY_MISMATCH',
    'AUTH_FAILED','RATE_LIMITED','FAILED'
  ));

ALTER TABLE serp_api_captures
  ADD COLUMN IF NOT EXISTS intent_class text NOT NULL DEFAULT 'NORMAL'
    CHECK (intent_class IN ('NORMAL','HYPERLOCAL')),
  ADD COLUMN IF NOT EXISTS trust_role text NOT NULL DEFAULT 'PRIMARY_ELIGIBLE'
    CHECK (trust_role IN ('PRIMARY_ELIGIBLE','SUPPORTING_ONLY')),
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS conflict_detail jsonb,
  ADD COLUMN IF NOT EXISTS provider_http_status integer,
  ADD COLUMN IF NOT EXISTS provider_search_status text,
  ADD COLUMN IF NOT EXISTS provider_latency_ms numeric(12,3),
  ADD COLUMN IF NOT EXISTS provider_response_content_type text;

ALTER TABLE serp_api_captures
  ADD COLUMN IF NOT EXISTS failure_latency_ms numeric(12,3);

UPDATE serp_api_captures
SET intent_class='HYPERLOCAL',trust_role='SUPPORTING_ONLY'
WHERE query ~* '(ใกล้ฉัน|ใกล้เคียง|near[[:space:]-]?me|nearby)';

UPDATE serp_api_captures
SET status='REJECTED_FOR_TARGET_CONTEXT',
    failure_code='HYPERLOCAL_CONTEXT_DISAGREEMENT',
    failure_summary='Provider-context observation retained as supporting evidence only',
    rejection_reason='HYPERLOCAL_CONTEXT_DISAGREEMENT',
    intent_class='HYPERLOCAL',
    trust_role='SUPPORTING_ONLY',
    conflict=true,
    conflict_detail=jsonb_build_object(
      'type','SERP_OBSERVATION_CONFLICT',
      'ownerDesktopPosition',2,
      'ownerRealMobilePosition',2,
      'providerTargetState','TARGET_NOT_FOUND_TOP_20',
      'policyVersion','hyperlocal-serp-trust-v1'
    ),
    normalized_result=normalized_result || jsonb_build_object(
      'conflict','SERP_OBSERVATION_CONFLICT',
      'intentClass','HYPERLOCAL',
      'trustRole','SUPPORTING_ONLY',
      'rejectionReason','HYPERLOCAL_CONTEXT_DISAGREEMENT'
    ),
    updated_at=now()
WHERE id='88c066e8-27f9-49e8-b651-f0fbf79146cf'
  AND status='PENDING_REVIEW'
  AND normalized_result IS NOT NULL;

INSERT INTO system_events(source,level,event,detail)
SELECT 'serp-trust-policy','INFO','SERP_CAPTURE_CONTEXT_REJECTED',jsonb_build_object(
  'captureId',c.id,
  'opportunityId',c.opportunity_id,
  'reason',c.rejection_reason,
  'intentClass',c.intent_class,
  'trustRole',c.trust_role,
  'conflict',c.conflict_detail
)
FROM serp_api_captures c
WHERE c.id='88c066e8-27f9-49e8-b651-f0fbf79146cf'
  AND c.status='REJECTED_FOR_TARGET_CONTEXT'
  AND NOT EXISTS (
    SELECT 1 FROM system_events e
    WHERE e.event='SERP_CAPTURE_CONTEXT_REJECTED'
      AND e.detail->>'captureId'=c.id::text
  );
