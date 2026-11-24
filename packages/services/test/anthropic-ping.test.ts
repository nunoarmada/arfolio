import { describe, expect, it, vi } from 'vitest';
import { parseInstanceSetting, pingAnthropic, smtpTransportOptions } from '../src/index.js';

const reply = (status: number, body: unknown) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

describe('pingAnthropic', () => {
  it('lists one model with the key and reports ok', async () => {
    const fetch = reply(200, { data: [], has_more: false, first_id: null, last_id: null });
    expect(await pingAnthropic('sk-test', { fetch })).toEqual({ ok: true, unavailableModels: [] });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('/v1/models');
    expect(String(url)).toContain('limit=1');
    expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer sk-test');
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('maps failures to fixed reasons that never carry the SDK text', async () => {
    const quoted = {
      type: 'error',
      error: { type: 'authentication_error', message: 'bad key sk-leak' },
    };
    for (const [status, reason] of [
      [401, 'invalid_key'],
      [403, 'invalid_key'],
      [429, 'rate_limited'],
      [500, 'unavailable'],
    ] as const) {
      const result = await pingAnthropic('sk-leak', { fetch: reply(status, quoted) });
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it('checks each distinct model once and names the ones the API does not know', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/models/claude-gone')) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: 'model: x' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = url.includes('limit=1')
        ? { data: [], has_more: false, first_id: null, last_id: null }
        : {
            id: 'claude-here',
            type: 'model',
            display_name: 'X',
            created_at: '2025-01-01T00:00:00Z',
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const result = await pingAnthropic('sk-test', {
      fetch,
      models: ['claude-here', 'claude-gone', 'claude-here', 'claude-gone'],
    });
    expect(result).toEqual({ ok: true, unavailableModels: ['claude-gone'] });
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes('/v1/models/claude-here'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/v1/models/claude-gone'))).toHaveLength(1);
  });

  it('does not check models when the key is rejected, and maps a model check failure to a fixed reason', async () => {
    const quoted = { type: 'error', error: { type: 'authentication_error', message: 'sk-leak' } };
    const rejected = reply(401, quoted);
    expect(await pingAnthropic('sk-leak', { fetch: rejected, models: ['claude-x'] })).toEqual({
      ok: false,
      reason: 'invalid_key',
    });
    expect(vi.mocked(rejected)).toHaveBeenCalledTimes(1);

    let calls = 0;
    const limited = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(
            JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        : new Response(JSON.stringify(quoted), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;
    expect(await pingAnthropic('sk-leak', { fetch: limited, models: ['claude-x'] })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('reports an unreachable API', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    expect(await pingAnthropic('sk-test', { fetch })).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('parseInstanceSetting', () => {
  it('rejects a model name that is empty or contains whitespace', () => {
    for (const key of [
      'ai.categorisationModel',
      'ai.reportModel',
      'ai.valuationModel',
      'ai.importModel',
    ] as const) {
      for (const bad of ['', 'claude x', 'claude\tx', ' claude-x', 'claude-x\n']) {
        expect(parseInstanceSetting(key, bad), `${key}=${JSON.stringify(bad)}`).toEqual({
          ok: false,
        });
      }
      expect(parseInstanceSetting(key, 'claude-x')).toEqual({ ok: true, value: 'claude-x' });
    }
  });

  it('applies the resolver rules to a value about to be stored', () => {
    expect(parseInstanceSetting('enableBanking.apiUrl', 'http://example.com')).toEqual({
      ok: false,
    });
    expect(parseInstanceSetting('enableBanking.apiUrl', 'http://localhost:4010')).toEqual({
      ok: true,
      value: 'http://localhost:4010',
    });
    expect(parseInstanceSetting('smtp.url', 'http://mail.example.test')).toEqual({ ok: false });
    expect(parseInstanceSetting('smtp.url', 'smtps://u:p@mail.example.test:465')).toMatchObject({
      ok: true,
    });
    for (const bad of [
      'smtp://h?sendmail=true&path=/bin/sh',
      'smtp://h:25?tls.rejectUnauthorized=false',
      'smtps://h#x',
      'sendmail://h',
      'smtp://',
      'smtp://u:%zz@h.example.com',
    ]) {
      expect(parseInstanceSetting('smtp.url', bad), bad).toEqual({ ok: false });
    }
    expect(
      parseInstanceSetting(
        'ai.valuationPortals',
        JSON.stringify({ property: ['Bad_Host'], vehicle: [], classifieds: [] }),
      ),
    ).toEqual({ ok: false });
    expect(parseInstanceSetting('enableBanking.privateKey', 'a\\nb')).toEqual({
      ok: true,
      value: 'a\nb',
    });
  });
});

const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 };

describe('smtpTransportOptions', () => {
  it('builds explicit options and decodes the credentials', () => {
    expect(smtpTransportOptions('smtps://us%40er:p%3Ass@mail.example.test')).toEqual({
      host: 'mail.example.test',
      port: 465,
      secure: true,
      auth: { user: 'us@er', pass: 'p:ss' },
      ...TIMEOUTS,
    });
    expect(smtpTransportOptions('smtp://mail.example.test:2525')).toEqual({
      host: 'mail.example.test',
      port: 2525,
      secure: false,
      ...TIMEOUTS,
    });
  });

  it('refuses a URL carrying options', () => {
    expect(() => smtpTransportOptions('smtp://h?sendmail=true')).toThrow();
  });
});
