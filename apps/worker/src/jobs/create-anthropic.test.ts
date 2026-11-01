import { describe, expect, it, vi } from 'vitest';
import { makeConfig } from '../test-config.js';

const ctor = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: unknown) {
      ctor(opts);
    }
  },
}));
vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

import { createAnthropic, createAnthropicMemo } from './ai-categorise.js';

const withKey = (k: string) => makeConfig({ anthropicApiKey: k });

describe('createAnthropic', () => {
  it('returns null without a key', () => {
    expect(createAnthropic(makeConfig())).toBeNull();
  });

  it('returns null for an unreadable key', () => {
    expect(createAnthropic(makeConfig({ unreadableKey: true }))).toBeNull();
  });

  it('keeps the SDK default retries unless asked, and can turn them off', () => {
    createAnthropic(withKey('k'));
    expect(ctor.mock.calls.at(-1)![0]).not.toHaveProperty('maxRetries');
    createAnthropic(withKey('k'), { maxRetries: 0 });
    expect(ctor.mock.calls.at(-1)![0]).toMatchObject({ maxRetries: 0, timeout: 120_000 });
  });

  it('keeps the 2 minute request timeout unless asked for another', () => {
    createAnthropic(withKey('k'));
    expect(ctor.mock.calls.at(-1)![0]).toMatchObject({ timeout: 120_000 });
    createAnthropic(withKey('k'), { maxRetries: 0, timeout: 600_000 });
    expect(ctor.mock.calls.at(-1)![0]).toMatchObject({ maxRetries: 0, timeout: 600_000 });
  });
});

describe('createAnthropicMemo', () => {
  it('reuses the client while the key is the same and rebuilds when it changes', () => {
    const get = createAnthropicMemo();
    const before = ctor.mock.calls.length;
    const a = get(withKey('key-1'));
    expect(get(withKey('key-1'))).toBe(a);
    expect(ctor.mock.calls.length).toBe(before + 1);
    const b = get(withKey('key-2'));
    expect(b).not.toBe(a);
    expect(ctor.mock.calls.at(-1)![0]).toMatchObject({ apiKey: 'key-2' });
    expect(ctor.mock.calls.length).toBe(before + 2);
  });

  it('returns null when the key disappears and builds again when it comes back', () => {
    const get = createAnthropicMemo();
    expect(get(withKey('k'))).not.toBeNull();
    expect(get(makeConfig())).toBeNull();
    const before = ctor.mock.calls.length;
    expect(get(withKey('k'))).not.toBeNull();
    expect(ctor.mock.calls.length).toBe(before + 1);
  });

  it('passes its options on to the client', () => {
    createAnthropicMemo({ maxRetries: 0, timeout: 600_000 })(withKey('k'));
    expect(ctor.mock.calls.at(-1)![0]).toMatchObject({ maxRetries: 0, timeout: 600_000 });
  });
});
