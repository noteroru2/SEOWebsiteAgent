# Owner-Priority Research

Owner-Priority Research records a commercially important owner-requested SEO investigation without fabricating a deterministic Opportunity. Active identity is the site, normalized query, and `OWNER_PRIORITY_SEO` research type. Repeated owner requests reuse the case and append an audit event.

The case stores owner intent separately from SEO evidence. It may optionally link to a future real Opportunity, but no automatic reconciliation, merge, threshold change, or Opportunity creation occurs. Case creation is owner-authorized and never authorizes AI, SERP collection, source modification, or Batch 7.

Deterministic reassessment reads the current finalized GSC window and query-to-page rows, validates both relevant source mappings against a clean read-only repository HEAD, and links applicable canonical Owner Facts by identity and hash. It persists five bounded findings and returns `READY_FOR_ANALYSIS` only when required stored context is complete and conflict-free. Optional newer-GSC and non-hyperlocal SERP requirements remain open without blocking initial readiness or scheduling work.

`evidence_requests` remains the evidence provenance boundary. Each request belongs to exactly one subject through a database XOR constraint: either `opportunity_id` or `owner_research_case_id`. Existing Opportunity requests and all `evidence_items` relationships remain unchanged.

## V3 analysis subject

The governed source-plan V3 pipeline accepts exactly one explicit analysis subject: an existing deterministic `OPPORTUNITY` or an `OWNER_RESEARCH_CASE`. Owner Research uses the case ID directly and never creates a synthetic Opportunity. Existing Opportunity analysis and historical prompt identities remain unchanged.

Owner Research V3 requires a fresh one-time authorization row. `READY_FOR_ANALYSIS` remains a data-readiness state and cannot enqueue or execute AI by itself. The worker consumes authorization against one job and one run before the provider request. Governed AI jobs keep `max_attempts = 1`; stale in-flight jobs fail rather than requeue.

The deterministic research context identity includes the case/query, stored finalized GSC window and queryÃ—page distribution, deterministic findings, clean source HEAD and mappings, current direct Owner Facts with provenance, and accepted optional evidence. SERP absence is explicit and is never synthesized. The subject-aware prompt is versioned as `source-change-plan-prompt-v4-owner-research` without rewriting historical V2/V3 identity.
