# Resource model

Target host: Hetzner CX23, 2 vCPU, 4 GB RAM, 40 GB disk, sharing capacity with AMPHON. Batch 2 remains local-only.

| Service    | Compose CPU ceiling | Memory ceiling |
| ---------- | ------------------: | -------------: |
| PostgreSQL |            0.75 CPU |         512 MB |
| Web        |            0.75 CPU |         512 MB |
| Worker     |            0.50 CPU |         256 MB |
| Total      |            2.00 CPU |        1.25 GB |

The worker requires 512 MB free host memory and 2 GB free disk before claiming heavy work. Linux load must not exceed 1.5 per CPU. Windows enforces memory and disk while reporting Unix load unavailable.

Crawler concurrency is one. The default delay is 300 ms, pages are capped at 500 by default and 5,000 absolutely, discovered queues at 25,000, redirects at five, retries at two, and HTML/XML bodies at 5 MiB. A response stream is cancelled when the ceiling is crossed. HTML bodies are not retained after extraction or stored in PostgreSQL. Page and issue inserts are chunked.

Database pools are capped at five connections per process. Site lists are limited to 100, recent jobs to five, and issue views to 100. Duplicate detection uses indexed grouping after page persistence. These controls are intended to keep a typical crawl well below the worker's 256 MB container ceiling; measured fixture results belong in the Batch report rather than being treated as production guarantees.
