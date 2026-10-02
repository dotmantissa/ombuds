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
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
