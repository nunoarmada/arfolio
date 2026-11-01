import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { oklchToHex } from '@arfolio/core';
import { BACKGROUND_HEX } from './brand';

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

function backgroundHex(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in globals.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const m = /--background:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(body);
  if (!m) throw new Error('--background is not a plain oklch() value');
  return oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

describe('BACKGROUND_HEX', () => {
  it('matches --background in globals.css (light and dark)', () => {
    expect(BACKGROUND_HEX.light).toBe(backgroundHex(':root'));
    expect(BACKGROUND_HEX.dark).toBe(backgroundHex('.dark'));
  });
});
