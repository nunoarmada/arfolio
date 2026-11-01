import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mismatchedPins, undeclaredExternals } from '../check-externals.mjs';

const metafile = (paths: string[]) => ({
  outputs: {
    'dist/index.js': {
      imports: paths.map((path) => ({ path, external: true })),
    },
  },
});

describe('undeclaredExternals', () => {
  it('reports external packages that are not declared dependencies', () => {
    const result = undeclaredExternals(metafile(['pg-boss', 'exceljs', 'csv-parse/sync']), {
      dependencies: { 'pg-boss': '1' },
    });
    expect(result.map((r) => r.pkg).sort()).toEqual(['csv-parse', 'exceljs']);
  });

  it('maps subpaths and scoped packages to the package name and ignores builtins', () => {
    const result = undeclaredExternals(
      metafile(['drizzle-orm/node-postgres', '@arfolio/db', 'node:fs', 'path', 'fs/promises']),
      { dependencies: { 'drizzle-orm': '1', '@arfolio/db': 'workspace:*' } },
    );
    expect(result).toEqual([]);
  });

  it('flags the packages the services import code needs', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const result = undeclaredExternals(metafile(['csv-parse/sync', 'exceljs', 'saxes']), pkg);
    expect(result).toEqual([]);
  });
});

describe('mismatchedPins', () => {
  it('reports shared dependencies pinned to different versions', () => {
    const result = mismatchedPins(
      { dependencies: { exceljs: '4.4.0', zod: '4.6.7', 'pg-boss': '1' } },
      { dependencies: { exceljs: '4.3.0', zod: '4.6.7', saxes: '5.0.1' } },
    );
    expect(result).toEqual([{ pkg: 'exceljs', worker: '4.4.0', services: '4.3.0' }]);
  });

  it('keeps the real worker and services pins in sync', () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(
      mismatchedPins(read('../package.json'), read('../../../packages/services/package.json')),
    ).toEqual([]);
  });
});
