/**
 * Splits `total` (integer minor units, may be negative) across `weights` pro rata, using the
 * largest-remainder method so the parts always sum exactly to `total`. All-zero weights split
 * equally; ties go to the earlier part. BigInt keeps the products exact.
 */
export function splitByWeights(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0 ? -1n : 1n;
  const abs = BigInt(Math.abs(total));
  const w = weights.every((x) => x === 0) ? weights.map(() => 1n) : weights.map((x) => BigInt(x));
  const sum = w.reduce((a, b) => a + b, 0n);

  const parts = w.map((x) => (abs * x) / sum);
  const remainders = w.map((x, i) => ({ i, r: (abs * x) % sum }));
  let left = abs - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i]! += 1n;
    left -= 1n;
  }
  return parts.map((p) => Number(p * sign));
}
