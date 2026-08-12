# Source-grounded change plans

A Batch 6 plan combines one persisted deterministic opportunity, its accepted Batch 5 recommendation, crawl/GSC provenance, and bounded read-only source context. It is a recommendation artifact, not a patch.

`GENERATE_SOURCE_CHANGE_PLAN` is manual and handles one opportunity. Eligibility requires OPEN or MONITOR status, an accepted Batch 5 analysis, a configured freshly validated clean repository, and deterministic mappings for every URL entity. Unresolved or ambiguous mappings fail before provider use.

The audited provider contract is `source-change-plan-prompt-v1`, schema `source-change-plan-schema-v1`, model `gpt-5.6-terra`, reasoning `medium`, concurrency one, and strict Structured Outputs. At most five controlled owner-reviewed items are allowed. Diffs, replacement files, Git commands, deployment instructions, and execution actions are forbidden. `NO_CHANGE` and `PROTECT_CURRENT_STATE` are first-class outcomes.

Every finding/change must cite a supplied path and a line range inside a supplied excerpt. Invalid or invented references reject the entire result. The evidence hash includes the opportunity fingerprint, accepted Batch 5 identity, repository HEAD, mapping, participating paths/hashes/excerpts, prompt, model, and reasoning. Identical successful evidence is reused at zero provider cost; changed source makes a plan `STALE`.

Plan statuses are `DRAFT`, `READY_FOR_REVIEW`, `APPROVED`, `REJECTED`, and `STALE`. Approval/rejection updates only PostgreSQL and records an audit event. Approval does not write source or website files and does not run Git, commit, push, or deploy.

Batch 7 is outside this implementation. It may later prepare a patch and validate it locally from an approved current plan, followed by separate owner approval. Production deployment always requires explicit authorization.
