import { connectSourceRepository, getDatabase, persistSourceRefresh } from '@seo-agent/database';
import { deriveAstroProjectMappings, inspectRepository } from './index';

const [siteName, repositoryRoot, expectedHead] = process.argv.slice(2);
if (!siteName || !repositoryRoot)
  throw new Error('Usage: admin-refresh <site-name> <repository-root> [expected-head]');
const { pool } = getDatabase();
try {
  const site = (await pool.query('SELECT id,url FROM sites WHERE name=$1 LIMIT 1', [siteName]))
    .rows[0];
  if (!site) throw new Error('Configured site not found');
  const state = await inspectRepository(repositoryRoot);
  if (expectedHead && state.headSha !== expectedHead)
    throw Object.assign(new Error('Repository HEAD does not match the owner-approved baseline'), {
      code: 'SOURCE_BASELINE_MISMATCH',
    });
  if (!state.clean)
    throw Object.assign(new Error('Repository worktree must be clean'), {
      code: 'SOURCE_REPOSITORY_DIRTY',
    });
  const repository = await connectSourceRepository(
    {
      siteId: site.id,
      localRoot: state.root,
      expectedRemote: state.originUrl ?? undefined,
      defaultBranch: state.branch ?? undefined,
    },
    pool,
  );
  const started = performance.now();
  const mappings = await deriveAstroProjectMappings(state);
  const result = await persistSourceRefresh(
    {
      siteId: site.id,
      repositoryId: String(repository.id),
      siteUrl: site.url,
      state,
      mappings,
      durationMs: Math.round(performance.now() - started),
    },
    pool,
  );
  process.stdout.write(
    JSON.stringify({
      siteId: site.id,
      repositoryId: repository.id,
      trackedFiles: state.trackedFiles.length,
      routes: result.routes,
      headSha: result.headSha,
      clean: state.clean,
    }),
  );
} finally {
  await pool.end();
}
