import { createSite, getDatabase } from './index';
import { sites } from './schema';
import { eq } from 'drizzle-orm';

const { db, pool } = getDatabase();
try {
  const existing = await db
    .select()
    .from(sites)
    .where(eq(sites.url, 'https://example.com/'))
    .limit(1);
  if (!existing.length) await createSite({ name: 'Demo Site', url: 'https://example.com' }, db);
  console.log('Demo data ready.');
} finally {
  await pool.end();
}
