import { createDatabase } from '@seo-agent/database';
const { pool } = createDatabase();
let healthy = false;
try {
  const result = await pool.query(
    "SELECT created_at > now() - interval '60 seconds' AS healthy FROM system_events WHERE source='worker' ORDER BY created_at DESC LIMIT 1",
  );
  healthy = result.rows[0]?.healthy === true;
} finally {
  await pool.end();
}
process.exitCode = healthy ? 0 : 1;
