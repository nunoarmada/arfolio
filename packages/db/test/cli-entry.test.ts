import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isCliEntry } from '../src/migrate.js';

describe('isCliEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pfm-cli-entry-'));
  const real = join(dir, 'real.js');
  const link = join(dir, 'link.js');
  writeFileSync(real, '');
  symlinkSync(real, link);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('matches the script path', () => {
    expect(isCliEntry(pathToFileURL(real).href, real)).toBe(true);
  });

  it('matches when started through a symlink', () => {
    expect(isCliEntry(pathToFileURL(real).href, link)).toBe(true);
  });

  it('does not match another script or a missing argv[1]', () => {
    expect(isCliEntry(pathToFileURL(real).href, join(dir, 'other.js'))).toBe(false);
    expect(isCliEntry(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
