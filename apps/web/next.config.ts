import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import withSerwistInit from '@serwist/next';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

// Security headers that do not depend on the request. The Content-Security-Policy for pages needs
// a per-request nonce and is set in src/proxy.ts; API responses get a locked-down one here.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

// One id per build: it is Next's build id and the revision of the precached /offline page, so a
// deploy that changes the page (or the brand it renders) makes installed workers refetch it.
const buildId = process.env.GIT_SHA?.trim() || randomUUID();

// The release version (root package.json, bumped by release-please) and commit, shown in Settings.
const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPackage.version,
    NEXT_PUBLIC_GIT_SHA: process.env.GIT_SHA?.trim() ?? '',
  },
  output: 'standalone',
  generateBuildId: () => buildId,
  poweredByHeader: false,
  // @arfolio/core, @arfolio/connectors, @arfolio/services and @arfolio/mcp ship TypeScript source; @arfolio/db is consumed
  // from its build output (dist).
  transpilePackages: ['@arfolio/core', '@arfolio/connectors', '@arfolio/services', '@arfolio/mcp'],
  serverExternalPackages: ['pg'],
  // The OG routes read static Geist WOFF files at runtime (see src/lib/og-image.tsx).
  outputFileTracingIncludes: {
    '/og': ['./src/assets/fonts/*.woff'],
    '/og/twitter': ['./src/assets/fonts/*.woff'],
  },
  // @arfolio/services, @arfolio/connectors and @arfolio/mcp are TypeScript source written with ESM-style ".js" import
  // specifiers: map them to the .ts files, for those packages only (a rule-level resolve, not the
  // whole build).
  webpack(webpackConfig: { module: { rules: unknown[] } }) {
    webpackConfig.module.rules.push({
      test: /\.[cm]?[jt]sx?$/,
      include: [
        fileURLToPath(new URL('../../packages/services/src', import.meta.url)),
        fileURLToPath(new URL('../../packages/connectors/src', import.meta.url)),
        fileURLToPath(new URL('../../packages/mcp/src', import.meta.url)),
      ],
      resolve: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
    });
    return webpackConfig;
  },
  // Statement uploads travel in a server action: the limit is the 10 MB file plus form overhead
  // (the services enforce the 10 MB again). Next applies one limit to every action, and an
  // action's body is read before its auth check can run, so the limit cannot be lowered without
  // breaking imports: cap request bodies at the ingress as well (nginx
  // proxy-body-size around 11m).
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; frame-ancestors 'none'",
          },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        // OAuth discovery documents (JSON): same locked-down CSP as the API. Their Cache-Control
        // (five minutes) is set by the route handlers.
        source: '/.well-known/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; frame-ancestors 'none'",
          },
        ],
      },
      {
        // A stale worker would pin old assets: browsers must always revalidate it.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
};

// @serwist/next is webpack-only, so the web app builds with `next build --webpack`.
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // The static offline page is the only page the worker stores (precached by URL at install).
  // Giving this list replaces the default glob of public/, which holds nothing but the generated
  // worker itself.
  additionalPrecacheEntries: [{ url: '/offline', revision: buildId }],
  disable: process.env.NODE_ENV === 'development',
});
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(withSerwist(config));
