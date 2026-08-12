import { getDatabase, opportunitySourceInput } from '@seo-agent/database';

const siteName = process.argv[2];
if (!siteName) throw new Error('Usage: pilot-mapping <site-name>');
const { pool } = getDatabase();
try {
  const opportunities = await pool.query(
    `SELECT o.id,o.kind,o.query FROM opportunities o JOIN sites s ON s.id=o.site_id WHERE s.name=$1 AND o.status='OPEN' ORDER BY o.score DESC`,
    [siteName],
  );
  const rows = [];
  let totalEntities = 0;
  let mapped = 0;
  let ambiguous = 0;
  let unresolved = 0;
  let multiFile = 0;
  for (const opportunity of opportunities.rows) {
    const input = await opportunitySourceInput(opportunity.id, pool);
    totalEntities += input.routes.length;
    const mappings = input.routes.map((route) => {
      const matches = input.mappings.filter(
        (item) =>
          item.route_path === route ||
          String(item.route_path).replace(/\/$/, '') === route.replace(/\/$/, ''),
      );
      if (!matches.length) {
        unresolved++;
        return { route, status: 'UNRESOLVED', source: null };
      }
      if (matches.length > 1 || matches[0].mapping_status === 'AMBIGUOUS') {
        ambiguous++;
        return { route, status: 'AMBIGUOUS', source: null };
      }
      mapped++;
      if ((matches[0].related_source_paths ?? []).length) multiFile++;
      return {
        route,
        status: matches[0].mapping_status,
        source: matches[0].primary_source_path,
        related: matches[0].related_source_paths,
      };
    });
    rows.push({ id: opportunity.id, kind: opportunity.kind, query: opportunity.query, mappings });
  }
  process.stdout.write(
    JSON.stringify(
      {
        opportunities: opportunities.rowCount,
        totalEntities,
        mapped,
        ambiguous,
        unresolved,
        multiFile,
        coverage: totalEntities ? mapped / totalEntities : 0,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
