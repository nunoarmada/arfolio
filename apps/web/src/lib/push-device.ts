export interface DeviceDescription {
  browser: string;
  os: string;
  kind: 'phone' | 'computer';
}

/** Order matters: Edge, Opera and Samsung Internet also say "Chrome"; iOS Chrome says "CriOS". */
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string, DeviceDescription['kind']]> = [
  [/iPhone|iPod/, 'iPhone', 'phone'],
  [/iPad/, 'iPad', 'phone'],
  [/Android/, 'Android', 'phone'],
  [/Windows/, 'Windows', 'computer'],
  [/Macintosh|Mac OS X/, 'macOS', 'computer'],
  [/CrOS/, 'ChromeOS', 'computer'],
  [/Linux|X11/, 'Linux', 'computer'],
];

/**
 * A friendly reading of a stored user agent ("Chrome", "Android"), or null when the browser or
 * the system is not recognised. The UI turns null into "Dispositivo desconhecido". Names are
 * product names, so they are not translated.
 */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription | null {
  if (!userAgent) return null;
  let browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent));
  // The installed iOS home-screen app is WebKit without the "Version/" or "Safari/" tokens.
  if (!browser && /iPhone|iPad|iPod/.test(userAgent) && /AppleWebKit/.test(userAgent)) {
    browser = 'Safari';
  }
  if (!browser || !system) return null;
  return { browser, os: system[1], kind: system[2] };
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Whether a browser subscription was made with the given VAPID public key (base64url). A browser
 * that reports no key gives nothing to compare, which counts as a match: replacing a subscription
 * on a guess would churn every device. A mismatch means the instance's key changed since.
 */
export function sameApplicationServerKey(
  current: ArrayBuffer | ArrayBufferView | null | undefined,
  publicKey: string,
): boolean {
  if (!current) return true;
  const have = ArrayBuffer.isView(current)
    ? new Uint8Array(current.buffer, current.byteOffset, current.byteLength)
    : new Uint8Array(current);
  const want = urlBase64ToBytes(publicKey);
  return have.length === want.length && have.every((byte, i) => byte === want[i]);
}
