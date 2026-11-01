import { z } from 'zod';

// Kind-specific details of an asset, stored as JSON. Every field is optional at schema level so a
// half-filled form can be saved; `aiReadiness` says what an AI estimate still needs. The kinds are
// plain strings here: @arfolio/core does not depend on @arfolio/db, where `AssetKind` lives.

/** Asset kinds the AI can value. */
export const AI_VALUATION_KINDS = ['real_estate', 'vehicle', 'other'] as const;

const text = (max = 120) => z.string().trim().min(1).max(max).optional();
const num = (min: number, max: number) => z.number().min(min).max(max).optional();
const year = () => z.number().int().min(1800).max(2100).optional();

export const realEstateDetailsSchema = z
  .object({
    propertyType: z
      .enum(['apartment', 'house', 'land', 'shop', 'office', 'garage', 'other'])
      .optional(),
    typology: z.enum(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6+']).optional(),
    municipality: text(),
    parish: text(),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{3}$/)
      .optional(),
    areaM2: num(1, 1_000_000),
    landAreaM2: num(1, 1_000_000),
    yearBuilt: year(),
    condition: z.enum(['new', 'good', 'needs_work']).optional(),
    parking: z.boolean().optional(),
    energyRating: z.enum(['A+', 'A', 'B', 'B-', 'C', 'D', 'E', 'F']).optional(),
  })
  .strict();

export const vehicleDetailsSchema = z
  .object({
    vehicleType: z.enum(['car', 'motorcycle', 'van', 'motorhome', 'other']).optional(),
    make: text(),
    model: text(),
    version: text(),
    year: year(),
    mileageKm: num(0, 5_000_000),
    fuel: z
      .enum(['petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'other'])
      .optional(),
    gearbox: z.enum(['manual', 'automatic']).optional(),
  })
  .strict();

export const otherDetailsSchema = z
  .object({
    category: z.enum(['boat', 'watch', 'jewellery', 'art', 'collectible', 'other']).optional(),
    brand: text(),
    model: text(),
    year: year(),
    lengthM: num(1, 200),
    condition: z.enum(['new', 'good', 'used', 'needs_work']).optional(),
    description: text(500),
  })
  .strict();

export type RealEstateDetails = z.infer<typeof realEstateDetailsSchema>;
export type VehicleDetails = z.infer<typeof vehicleDetailsSchema>;
export type OtherDetails = z.infer<typeof otherDetailsSchema>;
export type AssetDetails = RealEstateDetails | VehicleDetails | OtherDetails;

/** The details schema for a kind, or null for kinds without details (investment, cash). */
export function assetDetailsSchemaFor(kind: string): z.ZodType<AssetDetails> | null {
  switch (kind) {
    case 'real_estate':
      return realEstateDetailsSchema;
    case 'vehicle':
      return vehicleDetailsSchema;
    case 'other':
      return otherDetailsSchema;
    default:
      return null;
  }
}

/** Lenient parse for stored data: the parsed details when valid, otherwise null. Never throws. */
export function parseAssetDetails(kind: string, raw: unknown): AssetDetails | null {
  const schema = assetDetailsSchemaFor(kind);
  if (!schema) return null;
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

export type AiReadiness = { eligible: boolean; missing: string[] };

/** Whether the details are enough for an AI estimate; `missing` holds the field keys still needed. */
export function aiReadiness(kind: string, details: unknown): AiReadiness {
  if (!(AI_VALUATION_KINDS as readonly string[]).includes(kind)) {
    return { eligible: false, missing: [] };
  }
  const parsed = parseAssetDetails(kind, details);
  const d: Record<string, unknown> = parsed ? { ...parsed } : {};
  const missing: string[] = [];
  const need = (...keys: string[]) => {
    for (const key of keys) if (d[key] === undefined) missing.push(key);
  };

  if (kind === 'real_estate') {
    need('propertyType');
    if (d.municipality === undefined && d.postalCode === undefined) missing.push('municipality');
    need(d.propertyType === 'land' ? 'landAreaM2' : 'areaM2');
  } else if (kind === 'vehicle') {
    need('vehicleType', 'make', 'model', 'year', 'mileageKm');
  } else {
    need('category');
    if (d.category === 'boat' || d.category === 'watch') need('brand', 'model');
    else if (d.category !== undefined) need('description');
  }
  return { eligible: missing.length === 0, missing };
}
