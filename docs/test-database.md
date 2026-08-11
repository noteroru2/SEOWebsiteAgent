# Test database isolation

Development and automated tests use separate databases in the same local PostgreSQL container:

- Development: `seo_agent`
- Automated tests: `seo_agent_test`

`TEST_DATABASE_URL` is mandatory for database-backed tests. There is no fallback to
`DATABASE_URL`. The target name must end in `_test`, differ from the development target, run under
`NODE_ENV=test`, match PostgreSQL's live `current_database()`, and contain the marker installed by
`npm run db:test:prepare` before destructive reset is permitted.

The preparation command creates the disposable test database when needed, applies migrations
independently, and installs its marker. It never copies development sites, OAuth credentials, crawl
data, or Search Console metrics. Normal Compose web, worker, and migration services continue to use
only the development database.
