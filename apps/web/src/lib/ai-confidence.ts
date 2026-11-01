export type ConfidenceBand = 'likely' | 'uncertain';

/**
 * Words instead of percentages. At or above 0.85 the AI applied the category itself (no band is
 * shown, the row carries the "IA" badge); suggestions arrive between 0.50 and 0.85.
 */
export function confidenceBand(confidence: number | null): ConfidenceBand | null {
  if (confidence === null || !Number.isFinite(confidence)) return null;
  if (confidence >= 0.85) return null;
  return confidence >= 0.7 ? 'likely' : 'uncertain';
}
