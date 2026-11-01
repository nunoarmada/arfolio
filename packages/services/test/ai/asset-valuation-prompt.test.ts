import { describe, expect, it } from 'vitest';
import { portalsFor } from '../../src/ai/asset-valuation-prompt.js';
import { DEFAULT_VALUATION_PORTALS, type ValuationPortals } from '../../src/index.js';

const CUSTOM: ValuationPortals = {
  property: ['example.org'],
  vehicle: ['cars.example.org'],
  classifieds: ['ads.example.org'],
};

describe('portalsFor', () => {
  it('uses the default portals for each kind', () => {
    const d = DEFAULT_VALUATION_PORTALS;
    expect(portalsFor('real_estate', null, d)).toEqual(d.property);
    expect(portalsFor('vehicle', null, d)).toEqual(d.vehicle);
    expect(portalsFor('other', null, d)).toEqual(d.classifieds);
    expect(portalsFor('other', { category: 'boat' }, d)).toEqual([
      ...d.classifieds,
      'standvirtual.com',
    ]);
    expect(portalsFor('other', { category: 'watch' }, d)).toEqual([
      ...d.classifieds,
      'chrono24.pt',
    ]);
    expect(portalsFor('other', { category: 'art' }, d)).toBeNull();
    expect(portalsFor('other', { category: 'collectible' }, d)).toBeNull();
  });

  it('uses configured portals', () => {
    expect(portalsFor('real_estate', null, CUSTOM)).toEqual(['example.org']);
    expect(portalsFor('vehicle', null, CUSTOM)).toEqual(['cars.example.org']);
    expect(portalsFor('other', { category: 'boat' }, CUSTOM)).toEqual([
      'ads.example.org',
      'standvirtual.com',
    ]);
  });
});
