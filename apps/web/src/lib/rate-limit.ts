/** Small in-memory sliding-window limiter (per process): enough for a single-instance household app. */
export function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    /** Records an attempt; false when `key` already used its `max` attempts in the window. */
    take(key: string, now: number = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

/** Client address from the trusted proxy header (CLIENT_IP_HEADER, default x-real-ip), if any. */
export function clientIp(headers: Headers): string | undefined {
  return headers.get(process.env.CLIENT_IP_HEADER ?? 'x-real-ip') ?? undefined;
}

/** The same address as a rate-limit bucket key. */
export function clientKey(headers: Headers): string {
  return clientIp(headers) ?? 'unknown';
}
