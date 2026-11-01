import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  EnvError,
  integrationEnvShape,
  isHttpsOrLoopbackUrl,
  parseEnv,
  refineIntegrationEnv,
} from './env';

describe('parseEnv', () => {
  it('returns the parsed values when the source is valid', () => {
    expect(parseEnv(z.object({ A: z.string() }), { A: 'x' })).toEqual({ A: 'x' });
  });

  it('throws an EnvError listing every invalid key and never the values', () => {
    const schema = z.object({ A: z.string(), B: z.string().url() });
    let error: unknown;
    try {
      parseEnv(schema, { B: 'nope' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect(message).toContain('A');
    expect(message).toContain('B');
    expect(message).not.toContain('nope');
  });
});

describe('AI_VALUATION_MODEL', () => {
  const parse = (extra: Record<string, string>) =>
    parseEnv(z.object(integrationEnvShape), { ENCRYPTION_KEY: 'a'.repeat(64), ...extra });

  it('defaults to the report model and treats empty as unset', () => {
    expect(parse({}).AI_VALUATION_MODEL).toBe('claude-opus-5-5');
    expect(parse({ AI_VALUATION_MODEL: '' }).AI_VALUATION_MODEL).toBe('claude-opus-5-5');
  });

  it('accepts an override', () => {
    expect(parse({ AI_VALUATION_MODEL: 'custom-model' }).AI_VALUATION_MODEL).toBe('custom-model');
  });
});

describe('TRADING212_API_URL', () => {
  const parse = (extra: Record<string, string>) =>
    parseEnv(z.object(integrationEnvShape), { ENCRYPTION_KEY: 'a'.repeat(64), ...extra });

  it('defaults to the live API and treats empty as unset', () => {
    expect(parse({}).TRADING212_API_URL).toBe('https://live.trading212.com/api/v0');
    expect(parse({ TRADING212_API_URL: '' }).TRADING212_API_URL).toBe(
      'https://live.trading212.com/api/v0',
    );
  });

  it('accepts an override for tests and rejects a malformed URL', () => {
    expect(parse({ TRADING212_API_URL: 'http://127.0.0.1:9999/api/v0' }).TRADING212_API_URL).toBe(
      'http://127.0.0.1:9999/api/v0',
    );
    expect(() => parse({ TRADING212_API_URL: 'nope' })).toThrow(/TRADING212_API_URL/);
  });

  it('requires https in production, except for loopback hosts', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => parse({ TRADING212_API_URL: 'http://broker.example.test/api/v0' })).toThrow(
        /TRADING212_API_URL/,
      );
      expect(() => parse({ TRADING212_API_URL: 'ftp://127.0.0.1/api/v0' })).toThrow(
        /TRADING212_API_URL/,
      );
      for (const url of [
        'https://demo.trading212.com/api/v0',
        'http://127.0.0.1:9/api/v0',
        'http://localhost:9/api/v0',
        'http://[::1]:9/api/v0',
      ]) {
        expect(parse({ TRADING212_API_URL: url }).TRADING212_API_URL).toBe(url);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('allows plain http outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    try {
      expect(
        parse({ TRADING212_API_URL: 'http://broker.example.test/api/v0' }).TRADING212_API_URL,
      ).toBe('http://broker.example.test/api/v0');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.each(['ENABLE_BANKING_API_URL', 'TRADING212_API_URL'] as const)('%s hardening', (name) => {
  const parse = (value: string) =>
    parseEnv(z.object(integrationEnvShape), { ENCRYPTION_KEY: 'a'.repeat(64), [name]: value });

  it('requires https in production and allows loopback http only for the real loopback hosts', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => parse('http://api.example.test/v0')).toThrow(new RegExp(name));
      for (const url of [
        'https://api.example.test/v0',
        'http://127.0.0.1:9/v0',
        'http://localhost:9/v0',
        'http://[::1]:9/v0',
      ]) {
        expect(parse(url)[name]).toBe(url);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'http://localhost.evil.com/v0',
    'http://127.0.0.1.nip.io/v0',
    'http://127.0.0.1@evil.com/v0',
    'http://localhost@evil.com:80/v0',
    'http://evil.com/#@127.0.0.1',
    'http://127.0.0.1:9@evil.com/v0',
  ])('rejects the spoofed loopback host %s in production', (url) => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => parse(url)).toThrow(new RegExp(name));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects non-http schemes anywhere', () => {
    expect(() => parse('ftp://127.0.0.1/v0')).toThrow(new RegExp(name));
  });
});

describe('VAPID settings', () => {
  const PUB = 'B'.repeat(87);
  const PRIV = 'c'.repeat(43);
  const schema = z.object(integrationEnvShape).superRefine(refineIntegrationEnv);
  const parse = (extra: Record<string, string>) =>
    parseEnv(schema, { ENCRYPTION_KEY: 'a'.repeat(64), ...extra });

  it('are all optional and treat empty as unset', () => {
    const env = parse({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' });
    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(env.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(env.VAPID_SUBJECT).toBeUndefined();
  });

  it('accepts both keys together', () => {
    const env = parse({ VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: PRIV });
    expect(env).toMatchObject({ VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: PRIV });
  });

  it.each([
    ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'],
  ] as const)(
    'fails with an EnvError naming the missing key when only %s is set',
    (set, missing) => {
      let error: unknown;
      try {
        parse({ [set]: set === 'VAPID_PUBLIC_KEY' ? PUB : PRIV });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).keys).toEqual([missing]);
    },
  );

  it.each([
    [
      'public key of the wrong length',
      { VAPID_PUBLIC_KEY: 'B'.repeat(86), VAPID_PRIVATE_KEY: PRIV },
      'VAPID_PUBLIC_KEY',
    ],
    [
      'private key that is not base64url',
      { VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: '+'.repeat(43) },
      'VAPID_PRIVATE_KEY',
    ],
    ['http subject', { VAPID_SUBJECT: 'http://example.test' }, 'VAPID_SUBJECT'],
    ['subject without a scheme', { VAPID_SUBJECT: 'ops@example.test' }, 'VAPID_SUBJECT'],
  ])('rejects a %s', (_name, extra, key) => {
    expect(() => parse(extra)).toThrow(new RegExp(key));
  });

  it('accepts a mailto: or https: subject', () => {
    expect(parse({ VAPID_SUBJECT: 'mailto:ops@example.test' }).VAPID_SUBJECT).toBe(
      'mailto:ops@example.test',
    );
    expect(parse({ VAPID_SUBJECT: 'https://pfm.example.test' }).VAPID_SUBJECT).toBe(
      'https://pfm.example.test',
    );
  });
});

describe('PUSH_ALLOWED_HOSTS', () => {
  const parse = (extra: Record<string, string>) =>
    parseEnv(z.object(integrationEnvShape), { ENCRYPTION_KEY: 'a'.repeat(64), ...extra });

  it('is optional and empty counts as unset', () => {
    expect(parse({}).PUSH_ALLOWED_HOSTS).toBeUndefined();
    expect(parse({ PUSH_ALLOWED_HOSTS: '' }).PUSH_ALLOWED_HOSTS).toBeUndefined();
  });

  it('parses a comma-separated list, trimming and lower-casing', () => {
    expect(
      parse({ PUSH_ALLOWED_HOSTS: ' Push.Example.org, up.example.net ,' }).PUSH_ALLOWED_HOSTS,
    ).toEqual(['push.example.org', 'up.example.net']);
  });

  it.each([
    'com',
    'https://push.example.org',
    'push.example.org/x',
    'push.example.org.',
    '10.0.0.1',
    'a b.example.org',
  ])('rejects %s', (value) => {
    expect(() => parse({ PUSH_ALLOWED_HOSTS: value })).toThrow(/PUSH_ALLOWED_HOSTS/);
  });
});

describe('isHttpsOrLoopbackUrl', () => {
  it('accepts https and plain http only for loopback hosts, whatever NODE_ENV is', () => {
    expect(isHttpsOrLoopbackUrl('https://api.example.com')).toBe(true);
    expect(isHttpsOrLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isHttpsOrLoopbackUrl('http://127.0.0.1')).toBe(true);
    expect(isHttpsOrLoopbackUrl('http://[::1]:9')).toBe(true);
    expect(isHttpsOrLoopbackUrl('http://example.com')).toBe(false);
    expect(isHttpsOrLoopbackUrl('ftp://example.com')).toBe(false);
    expect(isHttpsOrLoopbackUrl('not a url')).toBe(false);
  });
});
