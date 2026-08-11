# AI recommendation layer

Batch 5 adds a manual, owner-reviewed reasoning layer over one persisted deterministic opportunity at a time. It uses the OpenAI Responses API with strict Structured Outputs. It does not scan a site, browse, call tools, read source repositories, edit files, publish content, deploy, or perform a recommended action.

The implementation follows OpenAI's official [Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs), and [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model). The default is `gpt-5.6-terra` with `medium` reasoning. `gpt-5.6-sol` is rejected by normal configuration and has no UI route; any future escalation requires a distinct owner-authorized workflow after a Terra result.

## Execution boundary

`ANALYZE_OPPORTUNITY` is a light, manually enqueued worker job containing one site ID and one opportunity ID. Only `OPEN` and `MONITOR` opportunities are eligible. The UI never calls the provider during rendering, and crawl, GSC sync, and opportunity generation never enqueue AI work. A top-actions workflow may be added later only as bounded individual jobs; this batch has no bulk action.

The worker processes provider calls sequentially. It checks cancellation before the request and before persistence. The request timeout defaults to 60 seconds. One retry is allowed only for explicitly transient rate-limit, selected provider 5xx, or timeout/network classifications. Authentication, schema, context, configuration, and budget failures are not retried.

## Context and prompt safety

The context builder loads only:

- site name, base URL, locale, and configured business facts;
- the persisted opportunity type, priority, confidence, score, fingerprint, summary, evidence, and unknown statement;
- a matching page's structured crawl fields and at most 20 findings when available;
- the opportunity's current/previous metrics, mapping reason, and at most five related persisted signals.

Raw HTML, page bodies, source repositories, provider requests, and secret values are never persisted. Because body content is unavailable, the context marks content review as required. Secondary evidence is capped before loading, while primary opportunity evidence is never silently dropped. The canonical provider input is limited to 24,000 characters and output to 2,200 tokens.

Prompt version `seo-recommendation-prompt-v1` and schema version `seo-recommendation-schema-v1` are persisted. The prompt places data inside an `EVIDENCE_DATA` delimiter and explicitly treats titles, headings, queries, URLs, and facts as untrusted data rather than instructions. No chain-of-thought is requested or stored. Thai is selected from persisted page language or `SEO_RECOMMENDATION_LOCALE`; machine enums remain English. There is no AMPHON-specific global prompt rule.

## Output contract

Strict Zod-backed Structured Outputs require a verdict, confidence, summary, evidence used, interpretations, recommended actions, do-not-do list, additional evidence needed, and unknowns. Strings and arrays are bounded. An analysis can return no more than five actions, with one to three preferred.

Every action uses a controlled review type. Execution, shell, file editing, deployment, deletion, automatic noindex, and automatic redirect actions are absent from the enum. Each action includes `LOW`, `MEDIUM`, or `HIGH` risk and the literal `requires_human_review: true`. Recommendations remain proposals in the opportunity detail panel; they are not converted into approvals or executable work.

## Persistence, reuse, and audit

- `ai_analysis_runs` records lifecycle, opportunity and evidence identity, versions, model configuration, estimate, usage, cost, provider request ID, latency, and safe failure details.
- `ai_recommendations` stores the validated structured result separately from the deterministic opportunity.
- `ai_usage` records every real provider attempt, including failed/retried attempts, without raw requests or credentials.
- job events record started, completed, failed, cancelled, reused, retry, and budget-blocked states with bounded safe details.

An analysis key hashes the stable opportunity fingerprint, canonical evidence hash, prompt/schema versions, model, reasoning effort, and output bound. An identical successful analysis is reused without an API call. The UI labels an explicit reanalysis as additional cost. Changed evidence creates a different key and permits a new analysis.

## Budgets and pricing metadata

Three hard checks run before a provider request: global monthly spend, per-site monthly spend, and maximum estimated cost for one analysis. Defaults are USD 28.50 globally, USD 8.50 per site, and USD 0.25 per analysis (approximately the pilot's THB 1,000/300 ceilings; exchange-rate conversion is intentionally not performed at runtime). A failed check persists `AI_BUDGET_EXCEEDED` and makes no API call.

Conservative configurable pricing metadata is centralized as USD per one million tokens:

| Model           | Input | Cached input | Output |
| --------------- | ----: | -----------: | -----: |
| `gpt-5.6-luna`  |  1.00 |         0.10 |   6.00 |
| `gpt-5.6-terra` |  2.50 |         0.25 |  15.00 |
| `gpt-5.6-sol`   |  5.00 |         0.50 |  30.00 |

These are deliberately conservative project accounting rates and should be reviewed against the official [model pricing page](https://developers.openai.com/api/docs/models/gpt-5.6-terra) before production use. Actual cost uses provider-reported input, cached input, and output tokens; preflight cost counts every input character as a token, assumes no cache discount, and reserves the full output allowance.

## Configuration

`OPENAI_API_KEY` is server-only and optional until real-pilot validation. Missing configuration disables the UI action and fails closed in the worker. Model, reasoning, timeout, budgets, and locale are environment-controlled. The key is never returned by a database query, rendered in UI, stored in PostgreSQL, included in an event, or printed by application code.

## Validation and real pilot gate

Automated tests use an injected fake provider exclusively and cover success, timeout, rate limiting, 5xx, authentication, malformed/schema output, budget blocking, reuse, explicit reanalysis, changed evidence, controlled actions, pricing, all opportunity guidance types, and injection-like page text. Test database resets remain restricted to `seo_agent_test`.

When a key is configured after fake tests pass, the first real validation is exactly three sequential Terra analyses: one HIGH striking-distance query, one HIGH low-CTR query, and one overlap candidate. Sol is not used. Tokens, cost, latency, verdict, confidence, actions, schema conformance, and manual quality are reviewed. Work stops for calibration if quality is below 80%; no additional real analyses are automatic.
