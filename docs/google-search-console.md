# Google Search Console

Batch 3 adds a read-only Google Search Console data pipeline. It uses the OAuth 2.0 web-server flow and requests only `https://www.googleapis.com/auth/webmasters.readonly`. Tokens remain server-side and are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`; the key must decode to 32 bytes. Missing or invalid configuration fails closed.

## Local OAuth setup

Create a Google Cloud OAuth web application, enable the Search Console API, and register `http://localhost:3000/api/google/callback` as an authorized redirect. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and an explicitly generated `APP_ENCRYPTION_KEY`. Production can later use `https://<agent-domain>/api/google/callback`; no production deployment is included here.

`APP_BASE_URL` is the browser-facing canonical origin and defaults locally to `http://localhost:3000`. It is intentionally separate from the web server's `0.0.0.0` bind host. OAuth success and failure redirects always use this canonical origin.

Connect from a site's Search Console page. The callback validates a one-time, hashed, ten-minute state before exchanging the code. Offline access is requested so a refresh token can support worker syncs. Access and refresh tokens are authenticated-encrypted in PostgreSQL and are never selected by UI queries. Disconnect clears local token ciphertext and disables future syncs while preserving historical metrics.

## Properties and sync policy

Property discovery uses the Sites API and retains URI, inferred `DOMAIN` or `URL_PREFIX` type, permission level, and discovery time. Domain and URL-prefix properties are supported. Mapping always requires explicit user selection.

The default search type is `web` and `dataState` is `final`. Initial sync covers 28 finalized days. Incremental sync re-fetches the latest three finalized dates as a correction window; older history remains untouched. A manual 90-day mode exists but is not automatically scheduled.

Each date is fetched separately for site/date, query, page, and query×page data. Requests use the official 25,000-row maximum and `startRow` pagination. API concurrency is one, retries are bounded for 429/transient 5xx/network failures, and `Retry-After` is respected. Ten pages per dataset/day is a defensive ceiling. Reaching it marks `POSSIBLY_TRUNCATED`; partial/cancelled/failed states never erase prior good data.

Search Analytics returns top rows and can be internally bounded, so `COMPLETE_AS_RETURNED` means the bounded API response was fully consumed—not that Google exposed every possible row. No raw API response JSON is stored.

## Storage, metrics, and crawl joins

Metric tables have uniqueness keys for site, property, search type, date, and their dataset dimensions. Repeated syncs use upserts. API pages are written in 500-row chunks and discarded. Summary CTR is total clicks divided by total impressions; average position is impression-weighted. Current and previous 28-day summaries are precomputed by the worker.

Crawl joins preserve URL path, query, and trailing-slash distinctions. Matching precedence is `EXACT_URL`, `FINAL_URL`, then `CANONICAL_MATCH`; URLs are never fuzzily joined.

Failure codes distinguish authentication, refresh, access, quota, Google API, network, invalid-property, partial, and cancellation conditions. Events record lifecycle progress without token values or row-level logs. Server-rendered views limit properties to 100, sync history to 20, and metric lists to 50.

Official references: [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Sites API](https://developers.google.com/webmaster-tools/v1/sites/list), and [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
