import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

const TTL_SECONDS = 3600;
const REFRESH_MARGIN_SECONDS = 300;

export type JwtSigner = { getToken(): string };

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** The RSA private key if `pem` is one, else undefined (never throws, never echoes the key). */
function parseRsaKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'rsa' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pem` is an RSA private key the JWT signer can use. */
export function isUsableEnableBankingKey(pem: string): boolean {
  return parseRsaKey(pem) !== undefined;
}

/** RS256 JWT for the Enable Banking API: 1 h TTL, cached until 5 min before expiry. */
export function createJwtSigner(opts: {
  appId: string;
  privateKeyPem: string;
  now?: () => number;
}): JwtSigner {
  const now = opts.now ?? Date.now;
  const key = parseRsaKey(opts.privateKeyPem);
  // Never echo the key material or the underlying parser message.
  if (!key) throw new Error('Invalid Enable Banking private key');
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: opts.appId }));
  let cached: { token: string; exp: number } | undefined;

  return {
    getToken() {
      const nowSeconds = Math.floor(now() / 1000);
      if (cached && nowSeconds < cached.exp - REFRESH_MARGIN_SECONDS) return cached.token;
      const exp = nowSeconds + TTL_SECONDS;
      const payload = b64url(
        JSON.stringify({
          iss: 'enablebanking.com',
          aud: 'api.enablebanking.com',
          iat: nowSeconds,
          exp,
        }),
      );
      const signingInput = `${header}.${payload}`;
      const signature = createSign('RSA-SHA256').update(signingInput).sign(key);
      cached = { token: `${signingInput}.${b64url(signature)}`, exp };
      return cached.token;
    },
  };
}
