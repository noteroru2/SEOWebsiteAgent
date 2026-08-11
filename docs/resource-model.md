# Resource model

Target host: Hetzner CX23, 2 vCPU, 4 GB RAM, 40 GB disk, sharing capacity with AMPHON. Batch 4 remains local-only.

| Service    | Compose CPU ceiling | Memory ceiling |
| ---------- | ------------------: | -------------: |
| PostgreSQL |            0.75 CPU |         512 MB |
| Web        |            0.75 CPU |         512 MB |
| Worker     |            0.50 CPU |         256 MB |
| Total      |            2.00 CPU |        1.25 GB |

The worker requires 512 MB free host memory and 2 GB free disk before claiming heavy work. Linux load must not exceed 1.5 per CPU. Windows enforces memory and disk while reporting Unix load unavailable.

Crawler concurrency is one. The default delay is 300 ms, pages are capped at 500 by default and 5,000 absolutely, discovered queues at 25,000, redirects at five, retries at two, and HTML/XML bodies at 5 MiB. A response stream is cancelled when the ceiling is crossed. HTML bodies are not retained after extraction or stored in PostgreSQL. Page and issue inserts are chunked.

Database pools are capped at five connections per process. Site lists are limited to 100, recent jobs to five, and issue views to 100. Duplicate detection uses indexed grouping after page persistence. These controls are intended to keep a typical crawl well below the worker's 256 MB container ceiling; measured fixture results belong in the Batch report rather than being treated as production guarantees.

Opportunity generation runs as a light job and cannot overlap for the same site. Its database loader groups before transfer and is bounded to 10,000 query signals, 5,000 page signals, 200 overlap groups, and 100 unmapped pages. Candidate cards are deduplicated by stable fingerprint, capped by type and page, and capped at 30 persisted results per run. UI reads are bounded to 100 cards, five dashboard cards, three site cards, and 20 related evidence rows.

AI analysis concurrency is one in the single worker. One job loads one primary opportunity, at most one matching structured page, 20 findings, and five related signals. Canonical provider input is capped at 24,000 characters and output at 2,200 tokens. Provider timeout is 60 seconds by default with at most one transient retry. The UI reads one latest analysis/recommendation plus aggregate monthly spend; it never aggregates raw crawl or GSC tables for AI during rendering. Database growth is bounded to one compact analysis row, one validated recommendation row, and one usage row per provider request attempt.

GSC API concurrency is one. Bootstrap is 28 finalized days, incremental correction is three finalized days, API pages are capped at 25,000 rows with ten pages per dataset/day, and upserts are chunked at 500 rows. Pages are released after each write; no full Query×Page history or raw response JSON is accumulated. Pilot retention keeps normalized historical metrics indefinitely.
