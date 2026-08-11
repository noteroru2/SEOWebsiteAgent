import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@seo-agent/database', '@seo-agent/shared'],
};
export default config;
