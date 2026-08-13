ALTER TABLE serp_api_captures
  ADD COLUMN IF NOT EXISTS actual_organic_count integer CHECK (actual_organic_count >= 0),
  ADD COLUMN IF NOT EXISTS maximum_observed_organic_position integer
    CHECK (maximum_observed_organic_position >= 0),
  ADD COLUMN IF NOT EXISTS pagination_start integer NOT NULL DEFAULT 0
    CHECK (pagination_start >= 0),
  ADD COLUMN IF NOT EXISTS pagination_performed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coverage_status text
    CHECK (coverage_status IS NULL OR coverage_status = 'EMPTY' OR coverage_status = 'PARTIAL'
      OR coverage_status ~ '^COMPLETE_THROUGH_[0-9]+$'),
  ADD COLUMN IF NOT EXISTS target_status text
    CHECK (target_status IS NULL OR target_status IN (
      'TARGET_FOUND','TARGET_NOT_FOUND_IN_RETURNED_RESULTS',
      'TARGET_NOT_FOUND_THROUGH_CONFIRMED_DEPTH','TARGET_UNKNOWN'
    )),
  ADD COLUMN IF NOT EXISTS rank_lower_bound_exclusive integer
    CHECK (rank_lower_bound_exclusive IS NULL OR rank_lower_bound_exclusive >= 0),
  ADD COLUMN IF NOT EXISTS exact_rank_known boolean,
  ADD COLUMN IF NOT EXISTS provider_location_requested text,
  ADD COLUMN IF NOT EXISTS provider_reported_precision text
    CHECK (provider_reported_precision IS NULL OR provider_reported_precision IN (
      'UNKNOWN','COUNTRY','REGION','CITY','COORDINATE'
    )),
  ADD COLUMN IF NOT EXISTS effective_evidence_context text,
  ADD COLUMN IF NOT EXISTS owner_comparison text
    CHECK (owner_comparison IS NULL OR owner_comparison IN (
      'EXACT','CLOSE','COMPATIBLE_WITH_OWNER_OBSERVATION','MATERIAL_CONFLICT','INSUFFICIENT_DATA'
    ));

WITH coverage AS (
  SELECT id,
    COALESCE(jsonb_array_length(normalized_result->'organicResults'),0) actual_count,
    COALESCE((
      SELECT max((item->>'position')::integer)
      FROM jsonb_array_elements(COALESCE(normalized_result->'organicResults','[]'::jsonb)) item
      WHERE item->>'position' ~ '^[0-9]+$'
    ),0) observed_depth
  FROM serp_api_captures
  WHERE normalized_result IS NOT NULL
)
UPDATE serp_api_captures c
SET actual_organic_count=v.actual_count,
    maximum_observed_organic_position=v.observed_depth,
    pagination_start=0,
    pagination_performed=false,
    coverage_status=CASE
      WHEN v.actual_count=0 THEN 'EMPTY'
      WHEN v.actual_count>=c.max_organic_results THEN 'COMPLETE_THROUGH_'||c.max_organic_results
      ELSE 'PARTIAL'
    END,
    target_status=CASE
      WHEN c.target_found THEN 'TARGET_FOUND'
      WHEN v.actual_count=0 THEN 'TARGET_UNKNOWN'
      WHEN v.actual_count>=c.max_organic_results THEN 'TARGET_NOT_FOUND_THROUGH_CONFIRMED_DEPTH'
      ELSE 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS'
    END,
    rank_lower_bound_exclusive=CASE WHEN c.target_found THEN NULL ELSE NULLIF(v.observed_depth,0) END,
    exact_rank_known=c.target_found,
    provider_location_requested=c.requested_location,
    provider_reported_precision='UNKNOWN',
    effective_evidence_context='VERIFIED_'||c.verified_precision||'_REQUEST',
    owner_comparison=COALESCE(c.owner_comparison,'INSUFFICIENT_DATA'),
    location_precision='UNKNOWN',
    normalized_result=(c.normalized_result - 'locationPrecision') || jsonb_build_object(
      'requestedOrganicLimit',c.max_organic_results,
      'actualOrganicCount',v.actual_count,
      'maximumObservedOrganicPosition',v.observed_depth,
      'paginationStart',0,
      'paginationPerformed',false,
      'coverageStatus',CASE
        WHEN v.actual_count=0 THEN 'EMPTY'
        WHEN v.actual_count>=c.max_organic_results THEN 'COMPLETE_THROUGH_'||c.max_organic_results
        ELSE 'PARTIAL'
      END,
      'targetStatus',CASE
        WHEN c.target_found THEN 'TARGET_FOUND'
        WHEN v.actual_count=0 THEN 'TARGET_UNKNOWN'
        WHEN v.actual_count>=c.max_organic_results THEN 'TARGET_NOT_FOUND_THROUGH_CONFIRMED_DEPTH'
        ELSE 'TARGET_NOT_FOUND_IN_RETURNED_RESULTS'
      END,
      'rankLowerBoundExclusive',CASE WHEN c.target_found THEN NULL ELSE NULLIF(v.observed_depth,0) END,
      'exactRankKnown',c.target_found,
      'providerLocationRequested',c.requested_location,
      'requestedVerifiedPrecision',c.verified_precision,
      'providerReportedPrecision','UNKNOWN',
      'effectiveEvidenceContext','VERIFIED_'||c.verified_precision||'_REQUEST'
    ),
    updated_at=now()
FROM coverage v
WHERE c.id=v.id;

UPDATE serp_api_captures
SET conflict=false,
    conflict_detail=jsonb_build_object(
      'type','COMPATIBLE_WITH_OWNER_OBSERVATION',
      'ownerPositions',jsonb_build_array(24),
      'providerTargetState','TARGET_NOT_FOUND_IN_RETURNED_RESULTS',
      'maximumObservedOrganicPosition',8,
      'reason','OWNER_POSITION_OUTSIDE_OBSERVED_DEPTH',
      'policyVersion','serp-coverage-location-semantics-v1'
    ),
    owner_comparison='COMPATIBLE_WITH_OWNER_OBSERVATION',
    evidence_quality='SERP_API_VERIFIED_CITY_REQUEST',
    normalized_result=(normalized_result - 'conflict') || jsonb_build_object(
      'conflict',NULL,
      'evidenceQuality','SERP_API_VERIFIED_CITY_REQUEST',
      'ownerComparison','COMPATIBLE_WITH_OWNER_OBSERVATION'
    ),
    updated_at=now()
WHERE id='53106b36-9283-4942-b93f-b20534b432d7'
  AND status='PENDING_REVIEW'
  AND target_found=false
  AND actual_organic_count=8
  AND maximum_observed_organic_position=8;
