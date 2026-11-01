import { describe, expect, it } from 'vitest';
import { describeDevice, sameApplicationServerKey, urlBase64ToBytes } from './push-device';

const ua = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefoxWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chromeIosCriOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  iphoneHomeScreen:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadHomeScreen:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

describe('describeDevice', () => {
  it.each([
    [ua.chromeAndroid, { browser: 'Chrome', os: 'Android', kind: 'phone' }],
    [ua.safariIphone, { browser: 'Safari', os: 'iPhone', kind: 'phone' }],
    [ua.firefoxWindows, { browser: 'Firefox', os: 'Windows', kind: 'computer' }],
    [ua.edgeWindows, { browser: 'Edge', os: 'Windows', kind: 'computer' }],
    [ua.chromeMac, { browser: 'Chrome', os: 'macOS', kind: 'computer' }],
    [ua.safariMac, { browser: 'Safari', os: 'macOS', kind: 'computer' }],
    [ua.chromeIosCriOS, { browser: 'Chrome', os: 'iPhone', kind: 'phone' }],
    [ua.chromeLinux, { browser: 'Chrome', os: 'Linux', kind: 'computer' }],
    [ua.operaWindows, { browser: 'Opera', os: 'Windows', kind: 'computer' }],
    [ua.iphoneHomeScreen, { browser: 'Safari', os: 'iPhone', kind: 'phone' }],
    [ua.ipadHomeScreen, { browser: 'Safari', os: 'iPad', kind: 'phone' }],
    [ua.samsung, { browser: 'Samsung Internet', os: 'Android', kind: 'phone' }],
  ])('parses %#', (agent, expected) => {
    expect(describeDevice(agent)).toEqual(expected);
  });

  it('is null when the browser or the system cannot be told', () => {
    expect(describeDevice(null)).toBeNull();
    expect(describeDevice('')).toBeNull();
    expect(describeDevice('curl/8.0')).toBeNull();
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0)')).toBeNull();
  });
});

describe('urlBase64ToBytes', () => {
  it('decodes base64url without padding', () => {
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes('-_8'))).toEqual([251, 255]);
  });
});

describe('sameApplicationServerKey', () => {
  const key = 'AQIDBA'; // bytes 1,2,3,4
  const buffer = (...bytes: number[]) => new Uint8Array(bytes).buffer;

  it('is true when the subscription was made with the current key', () => {
    expect(sameApplicationServerKey(buffer(1, 2, 3, 4), key)).toBe(true);
  });

  it('is false for another key of the same length', () => {
    expect(sameApplicationServerKey(buffer(1, 2, 3, 5), key)).toBe(false);
  });

  it('is false for a key of another length', () => {
    expect(sameApplicationServerKey(buffer(1, 2, 3), key)).toBe(false);
    expect(sameApplicationServerKey(buffer(1, 2, 3, 4, 5), key)).toBe(false);
  });

  it('reads only the bytes the buffer view covers', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    expect(sameApplicationServerKey(backing.subarray(1, 5), key)).toBe(true);
  });

  it('does not decide when the browser reports no key (nothing to compare, nothing to replace)', () => {
    expect(sameApplicationServerKey(null, key)).toBe(true);
    expect(sameApplicationServerKey(undefined, key)).toBe(true);
  });
});
