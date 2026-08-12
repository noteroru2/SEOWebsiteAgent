import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createDatabase,
  createSite,
  connectSourceRepository,
  persistSourceRefresh,
} from '@seo-agent/database';
import { requireTestDatabaseUrl, resetTestDatabase } from '../../database/src/test-safety';
import { buildSourceContext, deriveAstroProjectMappings, inspectRepository } from './index';

const execute = promisify(execFile);
const parent = await mkdtemp(path.join(tmpdir(), 'source-perf-'));
const repository = path.join(parent, 'repo');
const database = createDatabase(requireTestDatabaseUrl());
let peakRss = process.memoryUsage().rss;
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const cpuBefore = process.cpuUsage();
try {
  await resetTestDatabase(database.pool);
  await mkdir(path.join(repository, 'src/pages'), { recursive: true });
  await mkdir(path.join(repository, 'src/components'), { recursive: true });
  const writes = [];
  for (let i = 0; i < 1500; i++)
    writes.push(
      writeFile(
        path.join(repository, 'src/pages', `route-${i}.astro`),
        `---\nimport C from '../components/c-${i % 1000}.astro';\n---\n<h1>Route ${i}</h1>\n<C />\n`,
      ),
    );
  for (let i = 0; i < 1000; i++)
    writes.push(
      writeFile(
        path.join(repository, 'src/components', `c-${i}.astro`),
        `<p>Bounded fixture component ${i}</p>\n`,
      ),
    );
  await Promise.all(writes);
  sample();
  const git = async (...args: string[]) =>
    execute('git', args, {
      cwd: repository,
      windowsHide: true,
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });
  await git('init');
  await git('config', 'user.email', 'perf@example.com');
  await git('config', 'user.name', 'Performance Fixture');
  await git('add', '--', '.');
  await git('commit', '-m', 'synthetic source workload');
  sample();
  const refreshStarted = performance.now();
  const state = await inspectRepository(repository, [parent]);
  sample();
  const mappingStarted = performance.now();
  const mappings = await deriveAstroProjectMappings(state);
  const mappingMs = performance.now() - mappingStarted;
  sample();
  const sizeBefore = Number(
    (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
  );
  const site = await createSite(
    { name: 'Source Performance', url: 'https://source-perf.example.com/' },
    database.db,
  );
  const repo = await connectSourceRepository(
    { siteId: site.id, localRoot: state.root, defaultBranch: state.branch ?? undefined },
    database.pool,
  );
  await persistSourceRefresh(
    {
      siteId: site.id,
      repositoryId: String(repo.id),
      siteUrl: site.url,
      state,
      mappings,
      durationMs: Math.round(performance.now() - refreshStarted),
    },
    database.pool,
  );
  sample();
  const contextStarted = performance.now();
  const context = await buildSourceContext(
    state,
    mappings.find((item) => item.routePath === '/route-1499')!,
  );
  const contextMs = performance.now() - contextStarted;
  sample();
  const sizeAfter = Number(
    (await database.pool.query('SELECT pg_database_size(current_database()) size')).rows[0].size,
  );
  const cpu = process.cpuUsage(cpuBefore);
  process.stdout.write(
    JSON.stringify({
      trackedFiles: state.trackedFiles.length,
      routes: mappings.filter((item) => item.routePath.startsWith('/')).length,
      refreshDurationMs: Math.round((performance.now() - refreshStarted) * 10) / 10,
      mappingDurationMs: Math.round(mappingMs * 10) / 10,
      contextBuildMs: Math.round(contextMs * 10) / 10,
      contextFiles: context.files.length,
      contextCharacters: context.totalCharacters,
      peakWorkerRssMiB: Math.round(peakRss / 104857.6) / 10,
      cpuUserMs: Math.round(cpu.user / 100) / 10,
      cpuSystemMs: Math.round(cpu.system / 100) / 10,
      dbGrowthBytes: sizeAfter - sizeBefore,
    }),
  );
} finally {
  await database.pool.end();
  await rm(parent, { recursive: true, force: true });
}
