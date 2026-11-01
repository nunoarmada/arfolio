import { describe, expect, it } from 'vitest';
import { appLanguage, isAppLocale, resolveAppLocale } from './language';

describe('app language', () => {
  it('maps a tag to its language, English for anything unsupported', () => {
    expect(appLanguage('pt-PT')).toBe('pt');
    expect(appLanguage('pt-BR')).toBe('pt');
    expect(appLanguage('es-ES')).toBe('es');
    expect(appLanguage('FR_ca')).toBe('fr');
    expect(appLanguage('it')).toBe('it');
    expect(appLanguage('de-DE')).toBe('en');
    expect(appLanguage('')).toBe('en');
  });

  it('resolves any tag to a shipped locale', () => {
    expect(resolveAppLocale('fr-FR')).toBe('fr-FR');
    expect(resolveAppLocale('fr-BE')).toBe('fr-FR');
    expect(resolveAppLocale('es')).toBe('es-ES');
    expect(resolveAppLocale('en-GB')).toBe('en');
    expect(resolveAppLocale('nl-NL')).toBe('en');
  });

  it('recognises only the shipped tags', () => {
    expect(isAppLocale('it-IT')).toBe(true);
    expect(isAppLocale('it')).toBe(false);
    expect(isAppLocale(1)).toBe(false);
  });
});
