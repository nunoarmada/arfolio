/** Countries Enable Banking serves in Europe (ISO 3166-1 alpha-2): the picker's static list. */
export const BANK_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

export const isBankCountry = (
  value: string | undefined,
): value is (typeof BANK_COUNTRIES)[number] =>
  value !== undefined && (BANK_COUNTRIES as readonly string[]).includes(value);

/** Country names in the locale, sorted by that locale's collation. */
export function countryOptions(locale: string): Array<{ code: string; name: string }> {
  const names = new Intl.DisplayNames(locale, { type: 'region' });
  return BANK_COUNTRIES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
}

/**
 * The country to preselect: the region of the household locale ("pt-PT" gives PT); a language-only
 * locale ("en") falls back to the country of the latest bank connection, else nothing.
 */
export function defaultCountry(
  locale: string,
  latestConnectionCountry: string | null,
): string | null {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).region;
  } catch {
    region = undefined;
  }
  if (isBankCountry(region)) return region;
  return isBankCountry(latestConnectionCountry ?? undefined) ? latestConnectionCountry : null;
}
