import { afterEach, describe, expect, it, vi } from 'vitest';
import { psuHeadersFrom } from './psu-headers';

afterEach(() => vi.unstubAllEnvs());

describe('psuHeadersFrom', () => {
  it('takes the address from the configured proxy header and the browser User-Agent', () => {
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    expect(
      psuHeadersFrom(new Headers({ 'x-real-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0 Test' })),
    ).toEqual({ ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0 Test' });
  });

  it('honours CLIENT_IP_HEADER and ignores X-Forwarded-For', () => {
    vi.stubEnv('CLIENT_IP_HEADER', 'cf-connecting-ip');
    expect(
      psuHeadersFrom(
        new Headers({
          'cf-connecting-ip': '2001:db8::1',
          'x-forwarded-for': '198.51.100.9',
          'x-real-ip': '192.0.2.1',
        }),
      ),
    ).toEqual({ ipAddress: '2001:db8::1' });
  });

  it('leaves out what is missing or not an address', () => {
    expect(psuHeadersFrom(new Headers())).toEqual({});
    expect(psuHeadersFrom(new Headers({ 'x-real-ip': 'not-an-ip' }))).toEqual({});
    expect(psuHeadersFrom(new Headers({ 'x-real-ip': '1.2.3.4, 5.6.7.8' }))).toEqual({});
  });

  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '127.0.0.1',
    '169.254.10.10',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    '::ffff:192.168.0.1',
  ])('does not send a private, loopback or link-local address (%s)', (ip) => {
    expect(psuHeadersFrom(new Headers({ 'x-real-ip': ip, 'user-agent': 'Agent/1.0' }))).toEqual({
      userAgent: 'Agent/1.0',
    });
  });

  it.each(['172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '2001:db8::1', 'fec0::1'])(
    'still sends a public address (%s)',
    (ip) => {
      expect(psuHeadersFrom(new Headers({ 'x-real-ip': ip }))).toEqual({ ipAddress: ip });
    },
  );

  it('cleans and caps the User-Agent', () => {
    const noisy = `Agent/1.0 \té(${'x'.repeat(500)})`;
    const { userAgent } = psuHeadersFrom(new Headers({ 'user-agent': noisy }));
    expect(userAgent).toMatch(/^Agent\/1\.0 \(x+$/);
    expect(userAgent!.length).toBeLessThanOrEqual(200);
    expect(psuHeadersFrom(new Headers({ 'user-agent': 'é' }))).toEqual({});
  });
});
