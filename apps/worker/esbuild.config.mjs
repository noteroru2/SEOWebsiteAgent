import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';

const localFile = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entryPoints: [
    localFile('./src/index.ts'),
    localFile('./src/healthcheck.ts'),
    localFile('./src/migrate.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: localFile('./dist'),
  packages: 'external',
  alias: {
    '@seo-agent/database': localFile('../../packages/database/src/index.ts'),
    '@seo-agent/shared': localFile('../../packages/shared/src/index.ts'),
    '@seo-agent/resource-guard': localFile('../../packages/resource-guard/src/index.ts'),
    '@seo-agent/crawler': localFile('../../packages/crawler/src/index.ts'),
    '@seo-agent/seo-engine': localFile('../../packages/seo-engine/src/index.ts'),
    '@seo-agent/gsc': localFile('../../packages/gsc/src/index.ts'),
    '@seo-agent/opportunity-engine': localFile('../../packages/opportunity-engine/src/index.ts'),
  },
});
