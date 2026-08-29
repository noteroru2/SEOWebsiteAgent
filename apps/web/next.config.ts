import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@seo-agent/database',
    '@seo-agent/shared',
    '@seo-agent/gsc',
    '@seo-agent/serp-capture',
    '@seo-agent/source-understanding',
  ],
};
export default config;
