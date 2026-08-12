# Evidence resolution

Batch 6.4 adds a read-only evidence gate between owner-reviewed source plans and any future patch preparation. It does not create patches, approve plans, write to a managed source repository, deploy, or invoke AI automatically.

`evidence_requests` records the scoped requirement, reason, source, status, and whether it is required. `evidence_items` stores immutable, hashed evidence payloads with explicit provenance. Current completeness is derived from every required request; partial evidence does not make a request complete. Evidence packet identity excludes audit timestamps and uses only the latest item for each active request.

The internal resolver uses the existing GSC and source boundaries. GSC comparison uses the current finalized 28-day window and the immediately preceding 28 days. The `EVIDENCE_PREVIOUS_28D` sync mode requests only missing finalized dates, so current-window rows are not refetched or replaced. Query-to-page distribution is computed independently for both windows with safe zero-denominator behavior.

Targeted source evidence uses exact persisted route mappings and the validated read-only repository. All affected route primary files are considered before dependencies, under the unchanged 40,000-character ceiling. Missing mappings or material primary truncation keep the request open and are recorded rather than hidden.

Owner evidence is opportunity-scoped. Manual SERP observations are labeled `OWNER_OBSERVED_SERP`; business and ownership confirmations are labeled `OWNER_CONFIRMED`. Adding either stores evidence only. The UI exposes separate manual actions to refresh internal evidence and to request re-evaluation.

Evidence re-evaluation uses `source-change-plan-prompt-v3`, `gpt-5.6-terra`, medium reasoning, no tools, and the existing single-worker concurrency. The worker rejects the job before provider invocation unless completeness is `READY_FOR_REEVALUATION`. Historical v1/v2 plans remain unchanged. Even a successful v3 `PROPOSE_CHANGE` is not a patch: the deterministic patch-candidate gate additionally requires valid references, a current repository head, complete source evidence, resolved required owner evidence, a concrete bounded target, and no destructive URL/indexing action.

Repeated re-evaluation submissions are database-idempotent while queued or running: the partial unique job index admits one source-plan job per opportunity, and duplicate enqueue attempts return that active job. New jobs carry the evidence-packet hash, and the worker verifies it before provider invocation. The opportunity UI renders queued, analyzing, complete, failed, and worker-unavailable states, disables active submissions, and refreshes while work is active. A completed packet stays disabled until its deterministic evidence hash changes.
