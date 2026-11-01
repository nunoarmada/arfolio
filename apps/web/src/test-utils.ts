import {
  DEFAULT_VALUATION_PORTALS,
  type IntegrationConfig,
  type Resolved,
} from '@arfolio/services';
import type { Auth } from './lib/auth';

export const BASE_URL = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery';

export const testEnv = {
  DATABASE_URL: 'unused',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
  BETTER_AUTH_URL: BASE_URL,
  APP_URL: BASE_URL,
  SETUP_TOKEN: 'setup-token-0123456789-abcdef',
  ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
  BRAND_NAME: 'Testbrand',
  BRAND_PRIMARY_COLOR: '#336699',
  DEFAULT_LOCALE: 'pt-PT',
  CLIENT_IP_HEADER: 'x-real-ip',
};

let nextIp = 1;
/** A fresh client address, so tests do not share rate-limit buckets by accident. */
export function freshIp(): string {
  nextIp += 1;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
}

export async function post(
  auth: Auth,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
        'x-real-ip': freshIp(),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function get(
  auth: Auth,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'GET',
      headers: { origin: BASE_URL, 'x-real-ip': freshIp(), ...headers },
    }),
  );
}

export function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Signs in and returns request headers carrying the session cookie. */
export async function signInHeaders(
  auth: Auth,
  email: string,
  password = PASSWORD,
): Promise<Record<string, string>> {
  const res = await post(auth, '/sign-in/email', { email, password });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return { cookie: cookieOf(res) };
}

const unset = <T>(): Resolved<T> => ({
  value: undefined,
  source: 'unset',
  unreadable: false,
  invalid: false,
});
const set = <T>(value: T): Resolved<T> => ({
  value,
  source: 'db',
  unreadable: false,
  invalid: false,
});

/** An IntegrationConfig with nothing configured; pass raw values to set the ones a test needs. */
export function integrationConfigFixture(
  v: {
    anthropicApiKey?: string;
    appId?: string;
    privateKey?: string;
    apiUrl?: string;
    smtpUrl?: string;
    mailFrom?: string;
    unreadable?: ('appId' | 'privateKey')[];
  } = {},
): IntegrationConfig {
  const bank = (value: string | undefined, key: 'appId' | 'privateKey'): Resolved<string> => ({
    ...(value === undefined ? unset<string>() : set(value)),
    unreadable: v.unreadable?.includes(key) ?? false,
  });
  return {
    anthropicApiKey: v.anthropicApiKey === undefined ? unset() : set(v.anthropicApiKey),
    models: {
      categorisation: { ...set('claude-haiku-5-5'), source: 'default' },
      report: { ...set('claude-opus-5-5'), source: 'default' },
      valuation: { ...set('claude-opus-5-5'), source: 'default' },
    },
    valuationPortals: { ...set(DEFAULT_VALUATION_PORTALS), source: 'default' },
    enableBanking: {
      appId: bank(v.appId, 'appId'),
      privateKey: bank(v.privateKey, 'privateKey'),
      apiUrl: set(v.apiUrl ?? 'https://api.enablebanking.com'),
    },
    smtpUrl: v.smtpUrl === undefined ? unset() : set(v.smtpUrl),
    mailFrom: v.mailFrom === undefined ? unset() : set(v.mailFrom),
  };
}
