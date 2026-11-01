import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ptPT from '../../messages/pt-PT.json';
import { errorShortText, errorText, type ConnectionsT } from './connection-copy';

const translator =
  (messages: { connections: Record<string, unknown> }): ConnectionsT =>
  (key) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k],
        messages.connections,
      );
    if (typeof value !== 'string') throw new Error(`missing message connections.${key}`);
    return value;
  };

describe('skipped_rows copy', () => {
  it('has a short message in pt-PT', () => {
    const t = translator(ptPT);
    expect(errorText(t, 'skipped_rows', 'enablebanking')).toBe(
      'Alguns movimentos não puderam ser lidos',
    );
    expect(errorShortText(t, 'skipped_rows', 'enablebanking')).not.toBe(t('errorShort.internal'));
  });

  it('has a short message in en', () => {
    const t = translator(en);
    expect(errorText(t, 'skipped_rows', 'enablebanking')).toBe(
      'Some transactions could not be read',
    );
    expect(errorShortText(t, 'skipped_rows', 'enablebanking')).not.toBe(t('errorShort.internal'));
  });
});

describe('history_incomplete copy', () => {
  it.each([
    ['en', en],
    ['pt-PT', ptPT],
  ])('has its own messages in %s', (_locale, messages) => {
    const t = translator(messages);
    expect(errorText(t, 'history_incomplete', 'trading212')).not.toBe(t('error.internal'));
    expect(errorShortText(t, 'history_incomplete', 'trading212')).not.toBe(
      t('errorShort.internal'),
    );
  });
});
