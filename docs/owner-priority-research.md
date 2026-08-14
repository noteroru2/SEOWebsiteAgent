# Owner-Priority Research

Owner-Priority Research records a commercially important owner-requested SEO investigation without fabricating a deterministic Opportunity. Active identity is the site, normalized query, and `OWNER_PRIORITY_SEO` research type. Repeated owner requests reuse the case and append an audit event.

The case stores owner intent separately from SEO evidence. It may optionally link to a future real Opportunity, but no automatic reconciliation, merge, threshold change, or Opportunity creation occurs. Case creation is owner-authorized and never authorizes AI, SERP collection, source modification, or Batch 7.

Deterministic reassessment reads the current finalized GSC window and query-to-page rows, validates both relevant source mappings against a clean read-only repository HEAD, and links applicable canonical Owner Facts by identity and hash. It persists five bounded findings and returns `READY_FOR_ANALYSIS` only when required stored context is complete and conflict-free. Optional newer-GSC and non-hyperlocal SERP requirements remain open without blocking initial readiness or scheduling work.

`evidence_requests` remains the evidence provenance boundary. Each request belongs to exactly one subject through a database XOR constraint: either `opportunity_id` or `owner_research_case_id`. Existing Opportunity requests and all `evidence_items` relationships remain unchanged.

Future Owner-Priority V3 support should introduce an exactly-one-subject analysis context and nullable research-case references in the AI/source-plan persistence path. That adaptation is intentionally not part of V1: current Batch 5/6 execution continues to require an Opportunity, and `READY_FOR_ANALYSIS` is a data-readiness state only.
