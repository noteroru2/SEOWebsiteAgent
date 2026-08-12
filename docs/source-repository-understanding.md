# Read-only source repository understanding

Batch 6 connects a site to an explicitly supplied local Git working tree. The application understands source metadata and route provenance; it does not edit the website.

## Security boundary

`SOURCE_REPO_ALLOWED_ROOTS` is required and contains one or more absolute parent directories separated by the platform path delimiter. Repository roots are resolved with `realpath`, must be strict descendants of an allowed root, must be local directories, and must equal Git's reported top-level directory. There is no filesystem browser or arbitrary-path endpoint.

The Git adapter uses `execFile` with `shell: false` and exposes only fixed read operations: top-level, HEAD, current branch, porcelain status, tracked-file listing, and sanitized origin URL. Write commands and arbitrary passthrough are absent.

Only `git ls-files` paths can be read. Every file is resolved again and traversal or symlink escape is rejected. Allowed text types are Astro, Markdown/MDX, TypeScript/JavaScript, JSON, YAML, and CSS. Sensitive names (`.env*`, private keys, credentials, secrets, service accounts, and tokens), binaries, excluded dependency/build directories, and files over 512 KiB are rejected. Obvious secret-like values in otherwise allowed source are redacted before context construction.

## Route and context model

Static Astro `src/pages` routes map by convention. Dynamic routes remain unresolved without deterministic evidence. A narrow Astro adapter reads tracked content-collection frontmatter slugs for services, areas, service areas, and blog entries and links each to its tracked `[slug].astro` template. It never uses fuzzy filename or AI inference.

Mappings persist only metadata, paths, status, repository HEAD, and evidence. File evidence records normalized SHA-256, byte size, line count, and stable numbered excerpts. Relative local imports are followed only when deterministic, to depth 2. Context is limited to 6 files and 40,000 source characters, prioritizing mapped page/content files.

Repository text is explicitly untrusted data. No repository snapshot, embeddings, or vector database are created. `REFRESH_SOURCE_REPOSITORY` is manual and read-only; when HEAD changes it marks existing reviewable or approved plans stale without regenerating them.
