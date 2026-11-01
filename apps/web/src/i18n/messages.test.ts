import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es-ES.json';
import fr from '../../messages/fr-FR.json';
import itIT from '../../messages/it-IT.json';
import pt from '../../messages/pt-PT.json';
import { LOCALES, type Locale } from './locales';

const ALL: Record<Locale, object> = { 'pt-PT': pt, 'es-ES': es, 'fr-FR': fr, 'it-IT': itIT, en };

/** Flattens nested messages into dotted keys with their ICU placeholders. */
function flatten(obj: object, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(path, [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort());
    } else {
      for (const [k, v] of flatten(value as object, path)) out.set(k, v);
    }
  }
  return out;
}

/** Rich-text tag names (`<b>…</b>`), sorted, so a translation keeps every tag the UI renders. */
function tagsOf(obj: object, path: string): string[] {
  const value = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
  return [...(value as string).matchAll(/<(\w+)>/g)].map((m) => m[1]!).sort();
}

describe('messages', () => {
  const enKeys = flatten(en);

  it.each(LOCALES)('%s defines the same keys as en', (locale) => {
    expect([...flatten(ALL[locale]).keys()].sort()).toEqual([...enKeys.keys()].sort());
  });

  it.each(LOCALES)('%s uses the same placeholders and tags as en', (locale) => {
    for (const [key, placeholders] of flatten(ALL[locale])) {
      expect(placeholders, key).toEqual(enKeys.get(key));
      expect(tagsOf(ALL[locale], key), key).toEqual(tagsOf(en, key));
    }
  });

  it.each(LOCALES)('%s has no empty strings', (locale) => {
    const messages = ALL[locale];
    for (const [key] of flatten(messages)) {
      const value = key
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], messages);
      expect((value as string).trim(), key).not.toBe('');
    }
  });
});
