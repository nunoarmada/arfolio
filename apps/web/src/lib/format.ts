const capitalise = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** Server-side option lists for the household forms (computed once so server and client agree). */

export interface Option {
  value: string;
  label: string;
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'BRL'] as const;

export function currencyOptions(locale: string): Option[] {
  const names = new Intl.DisplayNames([locale], { type: 'currency' });
  return CURRENCIES.map((code) => ({
    value: code,
    label: `${capitalise(names.of(code) ?? code)} (${code})`,
  }));
}

/** 12 month names, January first, in the given locale. */
export function monthOptions(locale: string): Option[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: capitalise(fmt.format(new Date(Date.UTC(2026, i, 1)))),
  }));
}

export function timeZoneOptions(current?: string): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}
