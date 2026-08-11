# Read-only crawler

The crawler uses Node HTTP `fetch` plus Cheerio; normal crawling never launches Playwright. It identifies itself as `SEO Website Agent/1.0 (+local read-only crawler)` and makes one request at a time.

## Limits and politeness

- Default 500 pages; hard maximum 5,000.
- Default 300 ms between page requests.
- Default 10-second request timeout, five redirects, two retries, and 5 MiB parsed-body ceiling.
- Retry scope: transient network failures, 429, 502, 503, and 504 only.
- Discovered queue is at most ten times the configured page limit and never above 25,000.
- At most ten query variants per origin/path; session-ID parameters and obvious recursive/calendar traps are rejected.
- URLs above 2,048 characters are ignored.

Robots.txt is fetched once. Rules for `SEO Website Agent` or `*` use longest matching Allow/Disallow path. Missing robots continues safely; 5xx is conservative and blocks page requests. This is a deliberately small V1 parser and does not implement every Googlebot wildcard nuance.

Sitemaps come from robots declarations and `/sitemap.xml`. URL sets, sitemap indexes, and up to 50 same-host sitemap files are supported. External hosts are ignored. Discovery also follows normalized same-host HTML links.

## URL and SSRF safety

Normalization removes fragments, lowercases hosts, and removes default ports. It preserves paths, queries, and the distinction between `/page` and `/page/`. Every initial URL and every redirect destination is DNS-resolved and rejected if any address is loopback, private, link-local, unspecified, multicast/reserved, metadata-range, or an internal single-label hostname.

The only private-network escape hatch requires both an explicit option and `NODE_ENV=test`. Production cannot enable it accidentally.

## Cancellation and limitations

Cancellation is cooperative between requests; partial structured results and summary counts are saved. Heartbeats/progress events are low-frequency. V1 uses exact-host same-site matching, a simplified robots parser, and no JavaScript rendering. A bounded crawl cannot prove a URL is an orphan, so the UI says “orphan candidate.”
