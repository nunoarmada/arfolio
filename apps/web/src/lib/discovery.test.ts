import { describe, expect, it } from 'vitest';
import { withDiscoveryCache } from './discovery';

describe('withDiscoveryCache', () => {
  it('sets a five minute cache on a JSON response and keeps status and body', async () => {
    const res = withDiscoveryCache(
      new Response('{"a":1}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=15' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('max-age=300');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('does not cache errors', () => {
    const res = withDiscoveryCache(new Response(null, { status: 404 }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
