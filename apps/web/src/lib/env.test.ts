import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '@arfolio/core';
import { envSchema } from './env';

const KEY = 'ab'.repeat(32);
const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  APP_URL: 'http://localhost:3000',
  SETUP_TOKEN: 'y'.repeat(32),
  ENCRYPTION_KEY: KEY,
};

describe('web env defaults', () => {
  it('defaults DEFAULT_LOCALE to en', () => {
    expect(parseEnv(envSchema, base).DEFAULT_LOCALE).toBe('en');
  });

  it('defaults the integration settings', () => {
    const env = parseEnv(envSchema, base);
    expect(env.ENABLE_BANKING_API_URL).toBe('https://api.enablebanking.com');
    expect(env.AI_CATEGORISATION_MODEL).toBe('claude-haiku-5-5');
    expect(env.AI_REPORT_MODEL).toBe('claude-opus-5-5');
    expect(env.MERCHANT_LOGOS).toBe('on');
    expect(env.ENABLE_BANKING_APP_ID).toBeUndefined();
    expect(env.ENABLE_BANKING_PRIVATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('web env empty optional values', () => {
  it('treats empty strings as unset so defaults apply', () => {
    const env = parseEnv(envSchema, {
      ...base,
      ENABLE_BANKING_APP_ID: '',
      ENABLE_BANKING_PRIVATE_KEY: '',
      ENABLE_BANKING_API_URL: '',
      ANTHROPIC_API_KEY: '',
      AI_CATEGORISATION_MODEL: '',
      AI_REPORT_MODEL: '',
    });
    expect(env.ENABLE_BANKING_APP_ID).toBeUndefined();
    expect(env.ENABLE_BANKING_PRIVATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_BANKING_API_URL).toBe('https://api.enablebanking.com');
    expect(env.AI_CATEGORISATION_MODEL).toBe('claude-haiku-5-5');
    expect(env.AI_REPORT_MODEL).toBe('claude-opus-5-5');
  });
});

describe('web env ENCRYPTION_KEY', () => {
  it('accepts uppercase hex', () => {
    expect(parseEnv(envSchema, { ...base, ENCRYPTION_KEY: 'AB'.repeat(32) }).ENCRYPTION_KEY).toBe(
      'AB'.repeat(32),
    );
  });

  it('is required', () => {
    const rest: NodeJS.ProcessEnv = { ...base };
    delete rest.ENCRYPTION_KEY;
    expect(() => parseEnv(envSchema, rest)).toThrow(/ENCRYPTION_KEY/);
  });

  it.each(['short', 'zz'.repeat(32)])('rejects a malformed key without echoing it', (bad) => {
    let error: unknown;
    try {
      parseEnv(envSchema, { ...base, ENCRYPTION_KEY: bad });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).keys).toEqual(['ENCRYPTION_KEY']);
    expect((error as EnvError).message).not.toContain(bad);
  });
});

describe('web env ENABLE_BANKING_PRIVATE_KEY', () => {
  it('turns literal \\n sequences into newlines', () => {
    const env = parseEnv(envSchema, {
      ...base,
      ENABLE_BANKING_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    expect(env.ENABLE_BANKING_PRIVATE_KEY).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    );
  });

  it('leaves real newlines untouched', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(
      parseEnv(envSchema, { ...base, ENABLE_BANKING_PRIVATE_KEY: pem }).ENABLE_BANKING_PRIVATE_KEY,
    ).toBe(pem);
  });

  it('defaults to the Arfolio identity, overridable per installation', () => {
    const required = {
      DATABASE_URL: 'postgres://x',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      APP_URL: 'http://localhost:3000',
      SETUP_TOKEN: 'y'.repeat(32),
      ENCRYPTION_KEY: KEY,
    };
    const env = parseEnv(envSchema, { NODE_ENV: 'test', ...required });
    expect([env.BRAND_NAME, env.BRAND_PRIMARY_COLOR]).toEqual(['Arfolio', '#2F5BC2']);
    const custom = parseEnv(envSchema, {
      NODE_ENV: 'test',
      ...required,
      BRAND_NAME: 'Casa',
      BRAND_PRIMARY_COLOR: '#e0b000',
    });
    expect([custom.BRAND_NAME, custom.BRAND_PRIMARY_COLOR]).toEqual(['Casa', '#e0b000']);
  });
});

describe('web env VAPID pair', () => {
  it('fails when only one VAPID key is set', () => {
    expect(() => parseEnv(envSchema, { ...base, VAPID_PUBLIC_KEY: 'B'.repeat(87) })).toThrow(
      /VAPID_PRIVATE_KEY/,
    );
  });
});

describe('web env MCP_ALLOWED_REDIRECT_URIS', () => {
  it('is optional and an empty value counts as unset', () => {
    expect(parseEnv(envSchema, base).MCP_ALLOWED_REDIRECT_URIS).toBeUndefined();
    expect(
      parseEnv(envSchema, { ...base, MCP_ALLOWED_REDIRECT_URIS: '' }).MCP_ALLOWED_REDIRECT_URIS,
    ).toBeUndefined();
  });

  it('parses a comma separated list of absolute URIs', () => {
    const env = parseEnv(envSchema, {
      ...base,
      MCP_ALLOWED_REDIRECT_URIS: 'https://a.example/cb, https://b.example/cb',
    });
    expect(env.MCP_ALLOWED_REDIRECT_URIS).toEqual(['https://a.example/cb', 'https://b.example/cb']);
  });

  it('rejects entries that are not absolute URIs or carry a fragment', () => {
    for (const bad of ['not-a-uri', 'https://a.example/cb#x', 'https://a.example/cb,/relative']) {
      expect(() => parseEnv(envSchema, { ...base, MCP_ALLOWED_REDIRECT_URIS: bad })).toThrow(
        /MCP_ALLOWED_REDIRECT_URIS/,
      );
    }
  });
});

describe('web env APP_URL', () => {
  it('strips trailing slashes so `${APP_URL}/api/mcp` is the same everywhere', () => {
    for (const raw of ['https://pfm.example.com/', 'https://pfm.example.com//']) {
      expect(parseEnv(envSchema, { ...base, APP_URL: raw }).APP_URL).toBe(
        'https://pfm.example.com',
      );
    }
    expect(parseEnv(envSchema, base).APP_URL).toBe('http://localhost:3000');
  });
});
