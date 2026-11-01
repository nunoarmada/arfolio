import { afterEach, describe, expect, it, vi } from 'vitest';
import { testEnv } from '../test-utils';

const base = {
  DATABASE_URL: 'postgres://x',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  APP_URL: 'http://localhost:3000',
  SETUP_TOKEN: 'y'.repeat(32),
  ENCRYPTION_KEY: testEnv.ENCRYPTION_KEY,
};

async function manifestFor(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  return (await import('./manifest')).default();
}

describe('web app manifest', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the brand config, neutral chrome colours and the generated icons', async () => {
    const m = await manifestFor({
      BRAND_NAME: 'Casa Exemplo Familiar Longa',
      DEFAULT_LOCALE: 'pt-PT',
    });
    expect(m).toMatchObject({
      name: 'Casa Exemplo Familiar Longa',
      short_name: 'Casa Exemplo',
      lang: 'pt-PT',
      display: 'standalone',
      background_color: '#f4f6f8',
      theme_color: '#f4f6f8',
    });
    expect(m.icons).toEqual([
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('defaults the name to the default brand', async () => {
    const m = await manifestFor({});
    expect(m.name).toBe(m.short_name);
    expect(m.name).toBe('Arfolio');
  });
});
