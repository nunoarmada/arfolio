import type { AssetDetails } from '@arfolio/core';

/**
 * The details form of an asset, as plain data: which fields each kind shows and how typed text
 * becomes the `details` object the services store. Field keys and enum values mirror
 * `asset-details.ts` in @arfolio/core (a test keeps them in step); the labels live in the messages.
 */

export type DetailKind = 'real_estate' | 'vehicle' | 'other';

export interface DetailField {
  key: string;
  type: 'select' | 'text' | 'textarea' | 'integer' | 'decimal' | 'boolean';
  /** Enum values of a select, in the order shown. */
  options?: readonly string[];
  /** The option values are their own label (typology T2, energy rating A+). */
  rawOptions?: boolean;
  unit?: 'm2' | 'km' | 'm';
  min?: number;
  max?: number;
  maxLength?: number;
  /** Spans both columns of the form grid. */
  wide?: boolean;
}

const year = (key: string): DetailField => ({ key, type: 'integer', min: 1800, max: 2100 });
const text = (key: string, maxLength = 120): DetailField => ({ key, type: 'text', maxLength });

const FIELDS: Record<DetailKind, readonly DetailField[]> = {
  real_estate: [
    {
      key: 'propertyType',
      type: 'select',
      options: ['apartment', 'house', 'land', 'shop', 'office', 'garage', 'other'],
    },
    {
      key: 'typology',
      type: 'select',
      options: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6+'],
      rawOptions: true,
    },
    text('municipality'),
    text('parish'),
    { key: 'postalCode', type: 'text', maxLength: 8 },
    { key: 'areaM2', type: 'decimal', unit: 'm2', min: 1, max: 1_000_000 },
    { key: 'landAreaM2', type: 'decimal', unit: 'm2', min: 1, max: 1_000_000 },
    year('yearBuilt'),
    { key: 'condition', type: 'select', options: ['new', 'good', 'needs_work'] },
    {
      key: 'energyRating',
      type: 'select',
      options: ['A+', 'A', 'B', 'B-', 'C', 'D', 'E', 'F'],
      rawOptions: true,
    },
    { key: 'parking', type: 'boolean', wide: true },
  ],
  vehicle: [
    {
      key: 'vehicleType',
      type: 'select',
      options: ['car', 'motorcycle', 'van', 'motorhome', 'other'],
    },
    text('make'),
    text('model'),
    text('version'),
    year('year'),
    { key: 'mileageKm', type: 'integer', unit: 'km', min: 0, max: 5_000_000 },
    {
      key: 'fuel',
      type: 'select',
      options: ['petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'other'],
    },
    { key: 'gearbox', type: 'select', options: ['manual', 'automatic'] },
  ],
  other: [
    {
      key: 'category',
      type: 'select',
      options: ['boat', 'watch', 'jewellery', 'art', 'collectible', 'other'],
    },
    text('brand'),
    text('model'),
    year('year'),
    { key: 'lengthM', type: 'decimal', unit: 'm', min: 1, max: 200 },
    { key: 'condition', type: 'select', options: ['new', 'good', 'used', 'needs_work'] },
    { ...text('description', 500), type: 'textarea', wide: true },
  ],
};

/** The fields shown for a kind: none for investment and cash. */
export function detailFieldsFor(kind: string): readonly DetailField[] {
  return kind in FIELDS ? FIELDS[kind as DetailKind] : [];
}

/**
 * A non-negative decimal as typed in any app locale: comma or dot as the decimal mark, spaces
 * or dots before a comma as thousands. Null when it is not a number.
 */
export function parseDecimalInput(raw: string): number | null {
  const compact = raw.replace(/\s/g, '');
  if (compact === '') return null;
  const comma = compact.includes(',');
  const normal = comma ? compact.replace(/\./g, '').replace(',', '.') : compact;
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  return Number(normal);
}

/** A whole number; dots and spaces group thousands ("120.000", "120 000"). Null otherwise. */
export function parseIntegerInput(raw: string): number | null {
  const compact = raw.replace(/[\s.]/g, '');
  return /^\d+$/.test(compact) ? Number(compact) : null;
}

export type DetailValues = Record<string, string>;

const POSTAL_CODE = /^\d{4}-\d{3}$/;

/**
 * The `details` to send for what is typed: empty fields are left out and so is anything that is
 * not valid, whose keys come back in `invalid` so the form can say which. No fields at all is
 * `null`. Only the kind's own fields count.
 */
export function valuesToDetails(
  kind: string,
  values: DetailValues,
): { details: Record<string, string | number | boolean> | null; invalid: string[] } {
  const details: Record<string, string | number | boolean> = {};
  const invalid: string[] = [];
  for (const field of detailFieldsFor(kind)) {
    const raw = (values[field.key] ?? '').trim();
    if (raw === '') continue;
    if (field.type === 'boolean') {
      if (raw === 'true') details[field.key] = true;
    } else if (field.type === 'select') {
      if (field.options?.includes(raw)) details[field.key] = raw;
    } else if (field.type === 'integer' || field.type === 'decimal') {
      const n = field.type === 'integer' ? parseIntegerInput(raw) : parseDecimalInput(raw);
      const ok =
        n !== null &&
        n >= (field.min ?? 0) &&
        n <= (field.max ?? Infinity) &&
        (field.type === 'decimal' || Number.isInteger(n));
      if (ok) details[field.key] = n;
      else invalid.push(field.key);
    } else if (field.key === 'postalCode' && !POSTAL_CODE.test(raw)) {
      invalid.push(field.key);
    } else {
      details[field.key] = raw.slice(0, field.maxLength);
    }
  }
  return { details: Object.keys(details).length > 0 ? details : null, invalid };
}

/** Stored details as the strings the form edits, numbers in the locale's decimal style. */
export function detailsToValues(
  kind: string,
  details: Partial<AssetDetails> | Record<string, unknown> | null,
  locale: string,
): DetailValues {
  const format = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 2 });
  const values: DetailValues = {};
  const stored = (details ?? {}) as Record<string, unknown>;
  for (const field of detailFieldsFor(kind)) {
    const v = stored[field.key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number') {
      values[field.key] = field.type === 'integer' ? String(v) : format.format(v);
    } else if (typeof v === 'boolean') {
      if (v) values[field.key] = 'true';
    } else if (typeof v === 'string') {
      values[field.key] = v;
    }
  }
  return values;
}
