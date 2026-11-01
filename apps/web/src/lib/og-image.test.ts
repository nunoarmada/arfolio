import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testEnv } from '../test-utils';
import { decodePng } from './test-png';
import { ogLocale, ogName } from './og-image';

const req = (url: string, cookie?: string) =>
  new Request(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined);

describe('ogName', () => {
  it('uses 96px up to 12 characters, 72px up to 22 and 60px up to 30', () => {
    expect(ogName('Arfolio')).toEqual({ text: 'Arfolio', fontSize: 96 });
    expect(ogName('Casa dos Santos').fontSize).toBe(72);
    expect(ogName('a'.repeat(22))).toEqual({ text: 'a'.repeat(22), fontSize: 72 });
    expect(ogName('a'.repeat(23))).toEqual({ text: 'a'.repeat(23), fontSize: 60 });
    expect(ogName('a'.repeat(30))).toEqual({ text: 'a'.repeat(30), fontSize: 60 });
  });

  it('cuts longer names at a word boundary with an ellipsis', () => {
    const { text, fontSize } = ogName('Gestão financeira da família Exemplo');
    expect(fontSize).toBe(60);
    expect(text).toBe('Gestão financeira da família…');
    expect(Array.from(text).length).toBeLessThanOrEqual(30);
  });

  it('hard-cuts a single long word', () => {
    const { text } = ogName('x'.repeat(40));
    expect(text).toBe(`${'x'.repeat(29)}…`);
  });
});

describe('renderOg', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [630, 'pt-PT'],
    [600, 'en'],
  ] as const)('returns a %ipx-high PNG card (%s)', async (height, lang) => {
    vi.spyOn(process, 'cwd').mockReturnValue(fileURLToPath(new URL('../..', import.meta.url)));
    for (const [k, v] of Object.entries({
      DATABASE_URL: 'postgres://x',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      APP_URL: 'http://localhost:3000',
      SETUP_TOKEN: 'y'.repeat(32),
      ENCRYPTION_KEY: testEnv.ENCRYPTION_KEY,
    })) {
      vi.stubEnv(k, v);
    }
    const { renderOg } = await import('./og-image');
    const res = await renderOg(req(`/og?lang=${lang}`), height);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = decodePng(new Uint8Array(await res.arrayBuffer()));
    expect([png.width, png.height]).toEqual([1200, height]);
  });
});

describe('ogLocale', () => {
  it('prefers ?lang, then the locale cookie, then DEFAULT_LOCALE, then en', () => {
    vi.stubEnv('DEFAULT_LOCALE', 'pt-PT');
    expect(ogLocale(req('/og?lang=en', 'locale=pt-PT'))).toBe('en');
    expect(ogLocale(req('/og', 'a=b; locale=en'))).toBe('en');
    expect(ogLocale(req('/og?lang=fr'))).toBe('pt-PT');
    vi.stubEnv('DEFAULT_LOCALE', 'xx');
    expect(ogLocale(req('/og'))).toBe('en');
    vi.unstubAllEnvs();
  });
});
