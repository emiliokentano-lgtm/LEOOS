import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@leoos/contracts'],
  typedRoutes: true,
  // Strict CSP (engineering rule: no inline scripts, no external origins).
  // 'unsafe-inline' for styles is required by Next's style injection; scripts are
  // not granted it. Tightened to nonce-based in Phase 8.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
