# Resource model

Target host: Hetzner CX23, 2 vCPU, 4 GB RAM, 40 GB disk, sharing capacity with an existing application. Batch 1 remains local-only.

| Service    | Compose CPU ceiling | Memory ceiling |
| ---------- | ------------------: | -------------: |
| PostgreSQL |            0.75 CPU |         512 MB |
| Web        |            0.75 CPU |         512 MB |
| Worker     |            0.50 CPU |         256 MB |
| Total      |            2.00 CPU |        1.25 GB |

These are conservative future guardrails and leave host RAM for the existing application, operating system and filesystem cache. Before claiming heavy work, the worker requires by default 512 MB free memory and 2 GB free disk. Linux load must not exceed 1.5 per CPU. Windows does not provide a portable Unix load average, so memory and disk remain enforced while load is reported unavailable. The settings are configurable, but heavy concurrency is exactly one.

The database pool is capped at five connections per process. List queries are limited to 100 records, dashboard counts are aggregated, recent jobs are limited to five, and no raw crawl datasets are used for page rendering. The worker sleeps for two seconds when idle and does not use browser automation.
