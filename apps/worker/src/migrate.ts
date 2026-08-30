import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '@seo-agent/database';

const { db, pool } = createDatabase();
try {
  await migrate(db, { migrationsFolder: 'packages/database/migrations' });
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
