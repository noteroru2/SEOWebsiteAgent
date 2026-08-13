# Evidence Automation V1

## Verified SERP location transport

SERP API jobs use a persisted `serp_location_profiles` record rather than browser-supplied provider location text. The opportunity UI submits only the profile UUID. The server resolves the active site-scoped profile and snapshots its owner label, provider, canonical provider location, provider location ID, verified precision, country code, timezone, verification timestamp, and verification source into both the capture and `FETCH_SERP_API` job identity.

The worker compares the job snapshot, capture snapshot, and still-active profile before reserving quota. A provider mismatch, inactive profile, altered snapshot, missing provider identity, or precision downgrade blocks execution before reservation. SerpApi receives the canonical `location` string; the provider location ID remains internal provenance because the Google Search adapter does not use an independently verified location-ID search parameter.

Evidence Automation V1 adds two zero-AI owner workflows without changing the explicit V3 reevaluation gate.

## Reusable owner facts

New facts are created only from structured owner confirmation. Historical free-text evidence is preserved and is not interpreted or backfilled. Each fact stores a deterministic key, structured scope, value, status, review date, hash, and the original `OWNER_CONFIRMED_DIRECT` evidence item. Reuse is allowed only when every required fact has one or more equivalent active values, the exact configured scope matches, no conflict exists, review dates remain current, and original owner provenance is intact. The resolved request stores `OWNER_CONFIRMED_REUSED` references to the original facts and evidence items.

Review intervals are configured with the maintained fact definitions. Expired, superseded, wrong-scope, missing, and conflicting facts do not resolve a request.

## Browser SERP capture

`CAPTURE_SERP` is a PostgreSQL-backed heavy job. The worker starts one Chromium process for one capture and closes its browser context and process in `finally` blocks. It uses ordinary Playwright behavior: no login, CAPTCHA solving, proxy rotation, stealth plug-ins, or anti-bot bypass. Challenges become `CAPTURE_BLOCKED` and the manual workflow remains available.

The parser stores exact displayed text, decoded target URLs, an approximate organic position, feature states, parser versions, location/device provenance, and low-confidence fields. Unrecognized feature absence is `UNKNOWN`, never an asserted false. Playwright devices are labeled `EMULATED_DESKTOP` or `EMULATED_MOBILE`.

Screenshots are PNG files in the shared `serp_artifacts` volume, are capped at 12,000 pixels high, and are referenced by path and SHA-256. V1 retention is owner-managed; discarded database records retain audit metadata and artifacts can be pruned later with a dedicated retention job. Raw Google HTML is not stored.

Only `Confirm Observation` creates evidence and resolves the request. Owner corrections preserve machine and confirmed values. Confirming new evidence changes packet identity and marks current V3 plans stale, but never enqueues AI or reevaluation.
