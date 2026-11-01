import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * The only files that may format money with the raw `@arfolio/core` formatter. Everything else must use
 * `useFormatMoney()` / `getFormatMoney()`, so privacy mode reaches every amount on screen.
 */
const ALLOWED = new Set([
  // The privacy-aware formatter itself.
  'lib/money-privacy.ts',
  // Settings preview of the number format, on a fixed sample amount (not household data).
  'app/(app)/(shell)/settings/household/household-form.tsx',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const RAW_IMPORT = /import\s*\{[^}]*\bformatMoney\b[^}]*\}\s*from\s*'@pfm\/core'/s;

describe('privacy mode coverage', () => {
  it('formats every amount through the privacy-aware formatter', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => RAW_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .filter((file) => !ALLOWED.has(file))
      .sort();
    expect(offenders).toEqual([]);
  });
});
