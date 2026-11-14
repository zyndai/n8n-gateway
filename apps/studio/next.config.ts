import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // One self-contained server for the Docker image (`node apps/studio/server.js`).
  output: 'standalone',
  // This is an npm workspace: trace files from the repo root so the standalone output finds hoisted packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
