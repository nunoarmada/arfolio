import { EnvError } from '@arfolio/core';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const KEY = 'ab'.repeat(32);

describe('loadEnv', () => {
  it('applies defaults for the port, time zone and integrations', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: KEY })).toEqual({
      DATABASE_URL: 'postgres://x',
      ENCRYPTION_KEY: KEY,
      WORKER_HEALTH_PORT: 8081,
      TZ: 'UTC',
      ENABLE_BANKING_API_URL: 'https://api.enablebanking.com',
      TRADING212_API_URL: 'https://live.trading212.com/api/v0',
      AI_CATEGORISATION_MODEL: 'claude-haiku-5-5',
      AI_REPORT_MODEL: 'claude-opus-5-5',
      AI_VALUATION_MODEL: 'claude-opus-5-5',
      MERCHANT_LOGOS: 'on',
    });
  });

  it('treats empty optional values as unset', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x',
      ENCRYPTION_KEY: KEY,
      ENABLE_BANKING_APP_ID: '',
      ENABLE_BANKING_API_URL: '',
      ANTHROPIC_API_KEY: '',
      AI_CATEGORISATION_MODEL: '',
    });
    expect(env.ENABLE_BANKING_APP_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_BANKING_API_URL).toBe('https://api.enablebanking.com');
    expect(env.AI_CATEGORISATION_MODEL).toBe('claude-haiku-5-5');
  });

  it('reads the MERCHANT_LOGOS switch: on by default, empty means unset, anything else fails', () => {
    const base = { DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: KEY };
    expect(loadEnv({ ...base, MERCHANT_LOGOS: 'off' }).MERCHANT_LOGOS).toBe('off');
    expect(loadEnv({ ...base, MERCHANT_LOGOS: '' }).MERCHANT_LOGOS).toBe('on');
    expect(() => loadEnv({ ...base, MERCHANT_LOGOS: 'maybe' })).toThrow(/MERCHANT_LOGOS/);
  });

  it('requires a well-formed ENCRYPTION_KEY without echoing it', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'nothex' })).toThrow(
      expect.not.stringContaining('nothex'),
    );
  });

  it('normalises literal \\n in the Enable Banking private key', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x',
      ENCRYPTION_KEY: KEY,
      ENABLE_BANKING_PRIVATE_KEY: 'a\\nb',
    });
    expect(env.ENABLE_BANKING_PRIVATE_KEY).toBe('a\nb');
  });

  it('fails naming the key but never leaking values', () => {
    const secret = 'super-secret-value';
    let error: unknown;
    try {
      loadEnv({ DATABASE_URL: secret, ENCRYPTION_KEY: KEY, WORKER_HEALTH_PORT: 'abc' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).message).toContain('WORKER_HEALTH_PORT');
    expect((error as EnvError).message).not.toContain(secret);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});

describe('loadEnv VAPID pair', () => {
  it('fails when only one VAPID key is set', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://x',
        ENCRYPTION_KEY: KEY,
        VAPID_PRIVATE_KEY: 'c'.repeat(43),
      }),
    ).toThrow(/VAPID_PUBLIC_KEY/);
  });
});

describe('loadEnv APP_URL', () => {
  const base = { DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: KEY };

  it('is optional and accepts the public URL (the default VAPID subject)', () => {
    expect(loadEnv(base).APP_URL).toBeUndefined();
    expect(loadEnv({ ...base, APP_URL: '' }).APP_URL).toBeUndefined();
    expect(loadEnv({ ...base, APP_URL: 'https://pfm.example.com' }).APP_URL).toBe(
      'https://pfm.example.com',
    );
  });

  it('rejects a value that is not a URL', () => {
    expect(() => loadEnv({ ...base, APP_URL: 'not a url' })).toThrow(/APP_URL/);
  });
});
