import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appVersion, appVersionLabel } from './app-version';

const rootVersion = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version;

describe('appVersion', () => {
  it('equals the root package.json version', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(appVersion()).toBe(rootVersion);
  });
});

describe('appVersionLabel', () => {
  it('shows the version and the 7-character short sha when the sha is known', () => {
    expect(appVersionLabel('1.2.3', '0123456789abcdef')).toBe('v1.2.3 · 0123456');
  });

  it('shows only the version when the sha is unknown or blank', () => {
    expect(appVersionLabel('1.2.3', undefined)).toBe('v1.2.3');
    expect(appVersionLabel('1.2.3', '  ')).toBe('v1.2.3');
  });
});
