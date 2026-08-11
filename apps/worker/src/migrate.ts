import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, createSite, sites } from '@seo-agent/database';
import { eq } from 'drizzle-orm';

const { db, pool } = createDatabase();
try {
  await migrate(db, { migrationsFolder: 'packages/database/migrations' });
  const demo = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.url, 'https://example.com'))
    .limit(1);
  if (!demo.length) await createSite({ name: 'Demo Site', url: 'https://example.com' }, db);
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
