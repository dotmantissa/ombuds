import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * Ombuds web config.
 *
 * `serverExternalPackages` keeps the packages that reach for node built ins out of the
 * bundler. genlayer-js touches node:dns to force IPv4, and the Neon and Privy server
 * packages expect a real node runtime, so bundling them only causes trouble.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: [
    'genlayer-js',
    'undici',
    '@neondatabase/serverless',
    '@privy-io/server-auth',
    'pdf-lib',
  ],
  /**
   * Pin the file tracing root to this directory.
   *
   * There are two lockfiles here, one at the repository root for the deploy
   * scripts and one for the app, and Next picks a workspace root by searching
   * upwards for them. On at least one machine it walked straight past the
   * repository and chose a stray lockfile in the home directory. Tracing is what
   * decides which files are copied next to the serverless functions, and
   * data/sources.json has to be one of them, so it does not get left to a search
   * of whatever happens to sit in the parent folders.
   */
  outputFileTracingRoot: path.resolve(__dirname),
  outputFileTracingIncludes: {
    '/api/sources': ['./data/sources.json'],
    '/api/cases/[docket]/letter': ['./data/sources.json'],
    '/sources': ['./data/sources.json'],
    '/file': ['./data/sources.json'],
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
