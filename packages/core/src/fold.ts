/**
 * Case-, accent- and whitespace-insensitive form shared by description normalisation and rules.
 * Accents are stripped as Unicode marks (`\p{M}`) after NFD, so the source has no literal
 * combining characters for formatters to mangle.
 */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
