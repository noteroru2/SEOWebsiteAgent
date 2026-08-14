import { Client } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './index';
import { testDatabaseMarker, validateTestDatabaseUrl } from './test-safety';

const target = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, {
  developmentDatabaseUrl: process.env.DATABASE_URL,
  requireNodeEnv: false,
});
const maintenanceUrl = new URL(target.url);
maintenanceUrl.pathname = '/postgres';
const maintenance = new Client({ connectionString: maintenanceUrl.toString() });

await maintenance.connect();
try {
  const exists = await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', [
    target.databaseName,
  ]);
  if (!exists.rowCount)
    await maintenance.query(`CREATE DATABASE "${target.databaseName}" TEMPLATE template0`);
} finally {
  await maintenance.end();
}

const database = createDatabase(target.url);
try {
  await migrate(database.db, { migrationsFolder: 'packages/database/migrations' });
  const sql0021 = (await import('fs')).readFileSync('packages/database/migrations/0021_batch7_patch_workflows.sql', 'utf8');
  await database.pool.query(sql0021);
  await database.pool.query(
    `CREATE TABLE IF NOT EXISTS test_database_guard (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      marker text NOT NULL CHECK (marker = 'SEO_AGENT_TEST_DATABASE')
    )`,
  );
  await database.pool.query(
    `INSERT INTO test_database_guard(id,marker) VALUES(true,$1)
     ON CONFLICT(id) DO UPDATE SET marker=excluded.marker`,
    [testDatabaseMarker],
  );
  console.log('Dedicated test database is ready and migrated.');
} finally {
  await database.pool.end();
}
