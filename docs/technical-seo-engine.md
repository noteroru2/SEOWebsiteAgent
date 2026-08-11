# Deterministic technical SEO engine

The engine is code-only: no AI, embeddings, or arbitrary scoring. Indexability reasons are `INDEXABLE`, `NON_200`, `NOINDEX_META`, `NOINDEX_HEADER`, and `ROBOTS_BLOCKED`. A canonical to another URL is reported separately and does not itself make a page non-indexable.

## Issue codes

- HTTP/access: `HTTP_4XX`, `HTTP_5XX`, `REDIRECT_CHAIN`, `REDIRECT_LOOP`.
- Title: `TITLE_MISSING`, `TITLE_EMPTY`, `TITLE_TOO_SHORT`, `TITLE_TOO_LONG`, `TITLE_DUPLICATE`.
- Description: `META_DESCRIPTION_MISSING`, `META_DESCRIPTION_EMPTY`, `META_DESCRIPTION_TOO_SHORT`, `META_DESCRIPTION_TOO_LONG`, `META_DESCRIPTION_DUPLICATE`.
- Headings: `H1_MISSING`, `H1_MULTIPLE`, `H1_EMPTY`.
- Canonical: `CANONICAL_MISSING`, `CANONICAL_INVALID`, `CANONICAL_EXTERNAL`, `CANONICAL_NON_200`, `CANONICAL_REDIRECT`, `CANONICAL_MULTIPLE`, `CANONICAL_SELF_MISMATCH`.
- Indexability: `NOINDEX_PAGE`, `X_ROBOTS_NOINDEX`, `ROBOTS_BLOCKED`.
- Links: `BROKEN_INTERNAL_LINK`, `INTERNAL_LINK_REDIRECT`, `ORPHAN_CANDIDATE`.
- Sitemap: `SITEMAP_URL_NON_200`, `SITEMAP_URL_REDIRECT`, `SITEMAP_URL_NOINDEX`, `INDEXABLE_URL_NOT_IN_SITEMAP`, `SITEMAP_URL_NOT_DISCOVERED`.
- Content/technical: `VERY_LOW_WORD_COUNT`, `DUPLICATE_CONTENT_HASH`, `HTML_LANG_MISSING`, `VIEWPORT_MISSING`.

Severities are `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, and `INFO`; Batch 2 does not infer commercial importance, so ordinary technical failures are not exaggerated as critical.

Title 30–60 characters, description 70–160, and fewer than 100 words are configurable heuristic warnings—not Google rules. Duplicate title, description, and SHA-256 normalized body-text hash detection uses database grouping and indexes, never O(n²) comparisons. Content hashes are exact-change candidates, not semantic similarity.
