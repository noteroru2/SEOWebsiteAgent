# Architecture

The pilot is a small npm-workspaces monorepo with three runtime processes: Next.js web, PostgreSQL, and a TypeScript worker. PostgreSQL avoids a second queue service and preserves job state across restarts.

## Data flow

1. A validated server action inserts a `QUEUED` job and `ENQUEUED` event.
2. The worker checks resource thresholds, then transactionally claims one eligible row.
3. The job type must exist in the static allowlist. Batch 1 only registers `SYSTEM_TEST`.
4. Completion or failure updates structured fields and appends an audit event.
5. Bounded server-side queries render stored summaries; the browser does not poll.

The queue has `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED` states. Claims use `FOR UPDATE SKIP LOCKED`; an advisory transaction lock serializes selection, while a partial unique database index is the final concurrency invariant. On startup, the worker recovers jobs with stale heartbeats when attempts remain. A job handler must be idempotent before future retrying types are added.

Trust boundaries use Zod. SQL is parameterized. There is no arbitrary shell route, command interpolation, `eval`, AI call, credential handling, or repository mutation.
