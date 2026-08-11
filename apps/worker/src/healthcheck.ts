import { createDatabase } from '@seo-agent/database';
const { pool } = createDatabase();
try {
  const result = await pool.query(
    "SELECT created_at > now() - interval '60 seconds' AS healthy FROM system_events WHERE source='worker' ORDER BY created_at DESC LIMIT 1",
  );
  process.exit(result.rows[0]?.healthy ? 0 : 1);
} finally {
  await pool.end();
}
