import { describe, expect, it } from 'vitest';
import {
  AI_VALUATION_KINDS,
  aiReadiness,
  assetDetailsSchemaFor,
  otherDetailsSchema,
  parseAssetDetails,
  realEstateDetailsSchema,
  vehicleDetailsSchema,
} from './asset-details';

describe('aiReadiness', () => {
  it('accepts a real estate asset with type, municipality and area', () => {
    expect(
      aiReadiness('real_estate', { propertyType: 'apartment', municipality: 'Lisboa', areaM2: 80 }),
    ).toEqual({ eligible: true, missing: [] });
  });

  it('accepts a postal code in place of the municipality', () => {
    expect(
      aiReadiness('real_estate', { propertyType: 'house', postalCode: '1000-001', areaM2: 120 }),
    ).toEqual({ eligible: true, missing: [] });
  });

  it('lists the missing real estate fields', () => {
    expect(aiReadiness('real_estate', { propertyType: 'apartment' })).toEqual({
      eligible: false,
      missing: ['municipality', 'areaM2'],
    });
    expect(aiReadiness('real_estate', {}).missing).toEqual([
      'propertyType',
      'municipality',
      'areaM2',
    ]);
  });

  it('needs only the land area for land', () => {
    expect(
      aiReadiness('real_estate', {
        propertyType: 'land',
        municipality: 'Sintra',
        landAreaM2: 5000,
      }),
    ).toEqual({ eligible: true, missing: [] });
    expect(
      aiReadiness('real_estate', { propertyType: 'land', municipality: 'Sintra', areaM2: 50 })
        .missing,
    ).toEqual(['landAreaM2']);
  });

  it('lists the missing vehicle fields', () => {
    expect(
      aiReadiness('vehicle', {
        vehicleType: 'car',
        make: 'Renault',
        model: 'Clio',
        year: 2019,
      }),
    ).toEqual({ eligible: false, missing: ['mileageKm'] });
    expect(
      aiReadiness('vehicle', {
        vehicleType: 'car',
        make: 'Renault',
        model: 'Clio',
        year: 2019,
        mileageKm: 0,
      }),
    ).toEqual({ eligible: true, missing: [] });
  });

  it('needs brand and model for boats and watches', () => {
    expect(aiReadiness('other', { category: 'watch', brand: 'Rolex' })).toEqual({
      eligible: false,
      missing: ['model'],
    });
    expect(aiReadiness('other', { category: 'boat', brand: 'Beneteau', model: 'Oceanis' })).toEqual(
      { eligible: true, missing: [] },
    );
  });

  it('needs a description for the other categories and a category at all', () => {
    expect(aiReadiness('other', { category: 'art' })).toEqual({
      eligible: false,
      missing: ['description'],
    });
    expect(
      aiReadiness('other', { category: 'art', description: 'Oil painting, 1960' }).eligible,
    ).toBe(true);
    expect(aiReadiness('other', {}).missing).toEqual(['category']);
  });

  it('is never eligible for kinds the AI does not value', () => {
    expect(aiReadiness('investment', {})).toEqual({ eligible: false, missing: [] });
    expect(aiReadiness('cash', null)).toEqual({ eligible: false, missing: [] });
  });

  it('treats garbage details as not ready without throwing', () => {
    expect(aiReadiness('real_estate', 'x').eligible).toBe(false);
    expect(aiReadiness('real_estate', { areaM2: 'big' }).eligible).toBe(false);
    expect(aiReadiness('vehicle', null).eligible).toBe(false);
  });
});

describe('parseAssetDetails', () => {
  it('returns the parsed object when valid', () => {
    expect(parseAssetDetails('vehicle', { vehicleType: 'car', make: ' Seat ' })).toEqual({
      vehicleType: 'car',
      make: 'Seat',
    });
  });

  it('returns null for garbage and for kinds without details', () => {
    expect(parseAssetDetails('real_estate', 'x')).toBeNull();
    expect(parseAssetDetails('real_estate', { areaM2: 'big' })).toBeNull();
    expect(parseAssetDetails('investment', {})).toBeNull();
  });
});

describe('details schemas', () => {
  it('knows which kinds are eligible and which have a schema', () => {
    expect(AI_VALUATION_KINDS).toEqual(['real_estate', 'vehicle', 'other']);
    expect(assetDetailsSchemaFor('real_estate')).toBe(realEstateDetailsSchema);
    expect(assetDetailsSchemaFor('vehicle')).toBe(vehicleDetailsSchema);
    expect(assetDetailsSchemaFor('other')).toBe(otherDetailsSchema);
    expect(assetDetailsSchemaFor('investment')).toBeNull();
    expect(assetDetailsSchemaFor('cash')).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(realEstateDetailsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(vehicleDetailsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(otherDetailsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('validates the postal code format', () => {
    expect(realEstateDetailsSchema.safeParse({ postalCode: '1000' }).success).toBe(false);
    expect(realEstateDetailsSchema.safeParse({ postalCode: '1000-001' }).success).toBe(true);
  });

  it('enforces enums and numeric ranges', () => {
    expect(realEstateDetailsSchema.safeParse({ typology: 'T6+', energyRating: 'A+' }).success).toBe(
      true,
    );
    expect(realEstateDetailsSchema.safeParse({ typology: 'T7' }).success).toBe(false);
    expect(realEstateDetailsSchema.safeParse({ areaM2: 0 }).success).toBe(false);
    expect(realEstateDetailsSchema.safeParse({ yearBuilt: 1799 }).success).toBe(false);
    expect(vehicleDetailsSchema.safeParse({ mileageKm: -1 }).success).toBe(false);
    expect(vehicleDetailsSchema.safeParse({ fuel: 'plugin_hybrid' }).success).toBe(true);
    expect(otherDetailsSchema.safeParse({ lengthM: 201 }).success).toBe(false);
    expect(otherDetailsSchema.safeParse({ condition: 'used' }).success).toBe(true);
    expect(realEstateDetailsSchema.safeParse({ condition: 'used' }).success).toBe(false);
  });

  it('caps string lengths', () => {
    expect(vehicleDetailsSchema.safeParse({ make: 'x'.repeat(121) }).success).toBe(false);
    expect(otherDetailsSchema.safeParse({ description: 'x'.repeat(500) }).success).toBe(true);
    expect(otherDetailsSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false);
  });
});
