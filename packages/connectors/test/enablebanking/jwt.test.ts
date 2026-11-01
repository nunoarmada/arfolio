import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJwtSigner, isUsableEnableBankingKey } from '../../src/enablebanking/jwt.js';
import { generateTestKeyPair } from '../fakes/keys.js';

const keys = generateTestKeyPair();

function decode(token: string) {
  const [h, p, s] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('createJwtSigner', () => {
  it('signs RS256 with kid header and iss/aud/iat/exp claims, verifiable with the public key', () => {
    const signer = createJwtSigner({
      appId: 'app-123',
      privateKeyPem: keys.privateKeyPem,
      now: () => 1_700_000_000_000,
    });
    const t = decode(signer.getToken());
    expect(t.header).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' });
    expect(t.claims).toEqual({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(t.signingInput),
      createPublicKey(keys.publicKeyPem),
      t.signature,
    );
    expect(ok).toBe(true);
  });

  it('accepts a PKCS#1 PEM key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const signer = createJwtSigner({ appId: 'a', privateKeyPem: pem });
    expect(signer.getToken().split('.')).toHaveLength(3);
  });

  it('caches the token until 5 minutes before expiry, then re-signs', () => {
    let nowMs = 1_700_000_000_000;
    const signer = createJwtSigner({
      appId: 'a',
      privateKeyPem: keys.privateKeyPem,
      now: () => nowMs,
    });
    const first = signer.getToken();
    nowMs += (3600 - 301) * 1000;
    expect(signer.getToken()).toBe(first);
    nowMs += 2 * 1000; // now within the last 5 minutes
    const second = signer.getToken();
    expect(second).not.toBe(first);
    expect(decode(second).claims.iat).toBe(Math.floor(nowMs / 1000));
  });

  it('rejects an invalid key without echoing it', () => {
    expect(() => createJwtSigner({ appId: 'a', privateKeyPem: 'not-a-pem-SECRETVALUE' })).toThrow(
      /private key/i,
    );
    try {
      createJwtSigner({ appId: 'a', privateKeyPem: 'not-a-pem-SECRETVALUE' });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETVALUE');
    }
  });
});

describe('isUsableEnableBankingKey', () => {
  it('accepts an RSA private key and rejects anything else without throwing', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(isUsableEnableBankingKey(keys.privateKeyPem)).toBe(true);
    expect(isUsableEnableBankingKey(ec)).toBe(false);
    expect(isUsableEnableBankingKey(keys.publicKeyPem)).toBe(false);
    expect(
      isUsableEnableBankingKey('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----'),
    ).toBe(false);
    expect(isUsableEnableBankingKey('')).toBe(false);
  });

  it('createJwtSigner refuses a key that is not RSA, without echoing it', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => createJwtSigner({ appId: 'a', privateKeyPem: ec })).toThrow(
      'Invalid Enable Banking private key',
    );
  });
});
