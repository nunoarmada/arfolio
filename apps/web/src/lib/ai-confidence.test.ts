import { describe, expect, it } from 'vitest';
import { confidenceBand } from './ai-confidence';

describe('confidenceBand', () => {
  it('maps the brief’s bands', () => {
    expect(confidenceBand(0.84)).toBe('likely');
    expect(confidenceBand(0.7)).toBe('likely');
    expect(confidenceBand(0.69)).toBe('uncertain');
    expect(confidenceBand(0.5)).toBe('uncertain');
  });

  it('shows no band for applied (>= 0.85) or missing confidence', () => {
    expect(confidenceBand(0.85)).toBeNull();
    expect(confidenceBand(0.97)).toBeNull();
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceBand(Number.NaN)).toBeNull();
  });
});
