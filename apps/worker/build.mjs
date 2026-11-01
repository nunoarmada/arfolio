// Bundles the worker into dist/index.js (ESM). Only the TS-source workspace packages @arfolio/core and
// @arfolio/services are inlined; every other dependency (pg-boss is ESM-only, @arfolio/db ships a built dist) stays external
// and is resolved from node_modules at runtime.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { mismatchedPins, undeclaredExternals } from './check-externals.mjs';

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  packages: 'external',
  alias: {
    '@arfolio/connectors': fileURLToPath(
      new URL('../../packages/connectors/src/index.ts', import.meta.url),
    ),
    '@arfolio/core/server': fileURLToPath(
      new URL('../../packages/core/src/server.ts', import.meta.url),
    ),
    '@arfolio/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    '@arfolio/services': fileURLToPath(
      new URL('../../packages/services/src/index.ts', import.meta.url),
    ),
  },
  // `alias` targets are bundled only when not marked external; keep it that way explicitly.
  external: ['pg-boss', 'pg', 'drizzle-orm', 'drizzle-orm/*', 'zod', '@arfolio/db'],
});

// `pnpm deploy --prod` links only direct dependencies: an external import that apps/worker does not
// declare would crash the image with ERR_MODULE_NOT_FOUND.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const missing = undeclaredExternals(result.metafile, pkg);
if (missing.length > 0) {
  const list = missing.map((m) => `  ${m.pkg} (imported by ${m.importedBy})`).join('\n');
  process.stderr.write(
    `Worker bundle imports packages not declared in apps/worker/package.json:\n${list}\n`,
  );
  process.exit(1);
}

const servicesPkg = JSON.parse(
  readFileSync(new URL('../../packages/services/package.json', import.meta.url), 'utf8'),
);
const drift = mismatchedPins(pkg, servicesPkg);
if (drift.length > 0) {
  const list = drift
    .map((d) => `  ${d.pkg}: worker ${d.worker} vs @arfolio/services ${d.services}`)
    .join('\n');
  process.stderr.write(`apps/worker pins differ from @arfolio/services:\n${list}\n`);
  process.exit(1);
}
