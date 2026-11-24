import { describe, expect, it, vi } from 'vitest';
import { AiKeyChangedError, type IntegrationConfig } from '@arfolio/services';
import { createAiGate } from './ai-gate.js';
import { makeConfig } from './test-config.js';

vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/** A fake SDK client whose methods record the calls (and `this`) and never touch the network. */
function fakeClient() {
  const sent: string[] = [];
  const client = {
    messages: {
      async parse(this: unknown, params: { tag: string }) {
        sent.push(`parse ${params.tag}`);
        expect(this).toBe(client.messages);
        return { ok: params.tag };
      },
      async create(params: { tag: string }) {
        sent.push(`create ${params.tag}`);
        return { ok: params.tag };
      },
    },
    models: {
      async retrieve(id: string) {
        sent.push(`models ${id}`);
        return { id };
      },
    },
  };
  return { client, sent };
}

function setup(key: string | null = 'sk-ant-e2e-fake-key-one') {
  let cfg: IntegrationConfig = makeConfig({ anthropicApiKey: key ?? undefined });
  const getConfig = vi.fn(async () => cfg);
  const { client, sent } = fakeClient();
  const open = createAiGate('test', getConfig, (c) => (c.anthropicApiKey.value ? client : null));
  const setKey = (next: string | undefined) => {
    cfg = makeConfig({ anthropicApiKey: next });
  };
  return { open, setKey, sent, getConfig };
}

describe('createAiGate', () => {
  it('passes requests through while the key stays the same, reading the config each time', async () => {
    const { open, sent, getConfig } = setup();
    const ai = (await open())!;
    expect(await ai.anthropic.messages.parse({ tag: 'a' })).toEqual({ ok: 'a' });
    expect(await ai.anthropic.messages.create({ tag: 'b' })).toEqual({ ok: 'b' });
    expect(await ai.anthropic.models.retrieve('m')).toEqual({ id: 'm' });
    expect(sent).toEqual(['parse a', 'create b', 'models m']);
    // once to open the run, once before every request
    expect(getConfig).toHaveBeenCalledTimes(4);
  });

  it('throws before sending when the key was removed during the run', async () => {
    const { open, setKey, sent } = setup();
    const ai = (await open())!;
    await ai.anthropic.messages.parse({ tag: 'first' });
    setKey(undefined);
    await expect(ai.anthropic.messages.parse({ tag: 'second' })).rejects.toBeInstanceOf(
      AiKeyChangedError,
    );
    await expect(ai.anthropic.messages.create({ tag: 'third' })).rejects.toThrow(
      'The AI key changed during the run',
    );
    await expect(ai.anthropic.models.retrieve('m')).rejects.toBeInstanceOf(AiKeyChangedError);
    expect(sent).toEqual(['parse first']);
  });

  it('throws before sending when the key was replaced during the run', async () => {
    const { open, setKey, sent } = setup();
    const ai = (await open())!;
    setKey('sk-ant-e2e-fake-key-two');
    await expect(ai.anthropic.messages.create({ tag: 'x' })).rejects.toBeInstanceOf(
      AiKeyChangedError,
    );
    expect(sent).toEqual([]);
    // the next run opens with the new key and sends again
    const next = (await open())!;
    await next.anthropic.messages.create({ tag: 'y' });
    expect(sent).toEqual(['create y']);
  });

  it('opens nothing without a key', async () => {
    const { open } = setup(null);
    expect(await open()).toBeNull();
  });
});
