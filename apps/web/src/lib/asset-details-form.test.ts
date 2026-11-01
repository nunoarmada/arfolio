import { describe, expect, it } from 'vitest';
import {
  assetDetailsSchemaFor,
  parseAssetDetails,
  realEstateDetailsSchema,
  vehicleDetailsSchema,
  otherDetailsSchema,
} from '@arfolio/core';
import {
  detailFieldsFor,
  detailsToValues,
  parseDecimalInput,
  parseIntegerInput,
  valuesToDetails,
} from './asset-details-form';

describe('detail fields', () => {
  it('lists no fields for kinds without details', () => {
    expect(detailFieldsFor('investment')).toEqual([]);
    expect(detailFieldsFor('cash')).toEqual([]);
  });

  it.each([
    ['real_estate', realEstateDetailsSchema],
    ['vehicle', vehicleDetailsSchema],
    ['other', otherDetailsSchema],
  ] as const)('covers exactly the keys of the %s schema', (kind, schema) => {
    expect(
      detailFieldsFor(kind)
        .map((f) => f.key)
        .sort(),
    ).toEqual(Object.keys(schema.shape).sort());
  });

  it('offers exactly the enum values of the schema for every select', () => {
    for (const kind of ['real_estate', 'vehicle', 'other'] as const) {
      const shape = (assetDetailsSchemaFor(kind) as unknown as { shape: Record<string, unknown> })
        .shape;
      for (const field of detailFieldsFor(kind)) {
        if (field.type !== 'select') continue;
        const enumSchema = (shape[field.key] as { unwrap(): { options: string[] } }).unwrap();
        expect([...field.options!]).toEqual(enumSchema.options);
      }
    }
  });
});

describe('number input parsing', () => {
  it('reads decimals typed with a comma or a dot', () => {
    expect(parseDecimalInput('85,5')).toBe(85.5);
    expect(parseDecimalInput('85.5')).toBe(85.5);
    expect(parseDecimalInput(' 1 200,25 ')).toBe(1200.25);
    expect(parseDecimalInput('1.200,25')).toBe(1200.25);
    expect(parseDecimalInput('120')).toBe(120);
    expect(parseDecimalInput('1\u202f200,25')).toBe(1200.25);
    expect(parseDecimalInput('1\u00a0200,25')).toBe(1200.25);
  });
  it('rejects text, negatives and several separators', () => {
    expect(parseDecimalInput('abc')).toBeNull();
    expect(parseDecimalInput('-5')).toBeNull();
    expect(parseDecimalInput('1,2,3')).toBeNull();
    expect(parseDecimalInput('')).toBeNull();
  });
  it('reads whole numbers with or without thousands separators', () => {
    expect(parseIntegerInput('120000')).toBe(120000);
    expect(parseIntegerInput('120.000')).toBe(120000);
    expect(parseIntegerInput('120 000')).toBe(120000);
    expect(parseIntegerInput('2015')).toBe(2015);
  });
  it('rejects decimals and text as whole numbers', () => {
    expect(parseIntegerInput('12,5')).toBeNull();
    expect(parseIntegerInput('12k')).toBeNull();
    expect(parseIntegerInput('')).toBeNull();
  });
});

describe('valuesToDetails', () => {
  it('leaves empty fields out and trims text', () => {
    const r = valuesToDetails('real_estate', {
      propertyType: 'apartment',
      typology: '',
      municipality: '  Lisboa ',
      areaM2: '85,5',
      parking: 'true',
    });
    expect(r).toEqual({
      details: { propertyType: 'apartment', municipality: 'Lisboa', areaM2: 85.5, parking: true },
      invalid: [],
    });
  });

  it('returns no details at all when every field is empty', () => {
    expect(valuesToDetails('vehicle', { make: ' ', year: '' })).toEqual({
      details: null,
      invalid: [],
    });
  });

  it('flags numbers out of range or malformed, and a bad postal code, without dropping the rest', () => {
    const r = valuesToDetails('real_estate', {
      municipality: 'Porto',
      areaM2: 'grande',
      yearBuilt: '1500',
      postalCode: '1234',
    });
    expect(r.invalid.sort()).toEqual(['areaM2', 'postalCode', 'yearBuilt']);
    expect(r.details).toEqual({ municipality: 'Porto' });
  });

  it('only keeps fields of the selected kind', () => {
    const r = valuesToDetails('vehicle', { make: 'Renault', brand: 'Rolex', mileageKm: '85.000' });
    expect(r.details).toEqual({ make: 'Renault', mileageKm: 85000 });
  });

  it('drops a select value the kind does not offer', () => {
    expect(valuesToDetails('real_estate', { condition: 'used' }).details).toBeNull();
    expect(valuesToDetails('other', { condition: 'used' }).details).toEqual({ condition: 'used' });
  });

  it('produces details the schema accepts', () => {
    const r = valuesToDetails('vehicle', {
      vehicleType: 'car',
      make: 'Renault',
      model: 'Clio',
      version: '1.5 dCi',
      year: '2018',
      mileageKm: '120.000',
      fuel: 'diesel',
      gearbox: 'manual',
    });
    expect(r.invalid).toEqual([]);
    expect(parseAssetDetails('vehicle', r.details)).toEqual(r.details);
  });
});

describe('detailsToValues', () => {
  it('turns stored details into form strings in the locale decimal style', () => {
    const values = detailsToValues(
      'real_estate',
      { propertyType: 'house', areaM2: 85.5, yearBuilt: 1998, parking: true },
      'pt-PT',
    );
    expect(values).toMatchObject({
      propertyType: 'house',
      areaM2: '85,5',
      yearBuilt: '1998',
      parking: 'true',
    });
    expect(detailsToValues('real_estate', { areaM2: 85.5 }, 'en').areaM2).toBe('85.5');
  });
  it('gives no values for missing details and does not group thousands', () => {
    expect(detailsToValues('vehicle', null, 'pt-PT')).toEqual({});
    expect(detailsToValues('vehicle', { mileageKm: 120000 }, 'pt-PT').mileageKm).toBe('120000');
  });
});
