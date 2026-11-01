const MASK = '#';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** Country code, two check digits, then groups of up to four characters (checked below). */
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/gi;
/** 13-19 digits, optionally grouped with single spaces or dashes. */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
/** International numbers start with + and may use spaces, dots, dashes and brackets. */
const PHONE_INTERNATIONAL = /\+\d[\d ().-]{6,}\d/g;
/** Portuguese numbers written in three groups of three, e.g. 912 345 678. */
const PHONE_PT_GROUPED = /\b[239]\d{2}[ .-]\d{3}[ .-]\d{3}\b/g;
const LONG_DIGITS = /\d{6,}/g;

/**
 * Strips what could identify a person or an account from free text before it is sent to the AI
 * provider: emails, IBANs, card numbers, phone numbers and any digit run of six or more become `#`.
 * Short numbers stay, since they are part of merchant names ("CONTINENTE 123").
 */
export function redactForAi(text: string): string {
  return text
    .replace(EMAIL, MASK)
    .replace(IBAN_CANDIDATE, (match) =>
      // Words such as "ab12 casa cafe" fit the shape; a real IBAN carries many digits.
      (match.match(/\d/g)?.length ?? 0) >= 8 ? MASK : match,
    )
    .replace(CARD, MASK)
    .replace(PHONE_INTERNATIONAL, MASK)
    .replace(PHONE_PT_GROUPED, MASK)
    .replace(LONG_DIGITS, MASK)
    .replace(/\s+/g, ' ')
    .trim();
}
