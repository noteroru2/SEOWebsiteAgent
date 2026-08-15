import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, createSite, sites } from '@seo-agent/database';
import { eq } from 'drizzle-orm';

const { db, pool } = createDatabase();
try {
  await migrate(db, { migrationsFolder: 'packages/database/migrations' });
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
