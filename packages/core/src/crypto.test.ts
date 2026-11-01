import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptError, decryptSecret, encryptSecret, loadEncryptionKey } from './crypto';

const key = randomBytes(32);
const PLAINTEXT = 'sk-test-plaintext-value-123';
const AAD = 'connection:00000000-0000-0000-0000-000000000001';

describe('loadEncryptionKey', () => {
  it('parses 64 hex chars into 32 bytes', () => {
    const hex = 'ab'.repeat(32);
    const k = loadEncryptionKey(hex);
    expect(k).toHaveLength(32);
    expect(k.toString('hex')).toBe(hex);
  });

  it('accepts uppercase hex and yields the same key', () => {
    expect(loadEncryptionKey('AB'.repeat(32))).toEqual(loadEncryptionKey('ab'.repeat(32)));
  });

  it.each([
    ['too short', 'ab'.repeat(31)],
    ['too long', 'ab'.repeat(33)],
    ['non-hex', 'zz'.repeat(32)],
    ['empty', ''],
  ])('rejects a malformed key (%s)', (_name, bad) => {
    expect(() => loadEncryptionKey(bad)).toThrow(/ENCRYPTION_KEY/);
  });

  it('never echoes the rejected value', () => {
    const bad = 'not-hex-secret-material';
    expect(() => loadEncryptionKey(bad)).toThrow(expect.not.stringContaining(bad));
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret(PLAINTEXT, key, AAD), key, AAD)).toBe(PLAINTEXT);
  });

  it('round-trips unicode and empty strings', () => {
    for (const s of ['', 'çãõ €✓']) {
      expect(decryptSecret(encryptSecret(s, key, AAD), key, AAD)).toBe(s);
    }
  });

  it('formats as v1.<iv>.<ciphertext>.<tag> in base64url', () => {
    const parts = encryptSecret(PLAINTEXT, key, AAD).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const p of parts.slice(1)) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(16);
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(PLAINTEXT, key, AAD)).not.toBe(encryptSecret(PLAINTEXT, key, AAD));
  });

  it('does not contain the plaintext', () => {
    expect(encryptSecret(PLAINTEXT, key, AAD)).not.toContain(PLAINTEXT);
  });

  it.each([
    ['version', 0],
    ['iv', 1],
    ['ciphertext', 2],
    ['tag', 3],
  ])('rejects a tampered %s', (_name, index) => {
    const parts = encryptSecret(PLAINTEXT, key, AAD).split('.');
    const part = parts[index]!;
    parts[index] = index === 0 ? 'v2' : (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    expect(() => decryptSecret(parts.join('.'), key, AAD)).toThrow(DecryptError);
  });

  it('rejects a tampered last character of the tag', () => {
    const parts = encryptSecret(PLAINTEXT, key, AAD).split('.');
    const tag = parts[3]!;
    const last = tag.at(-1)!;
    parts[3] = tag.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(() => decryptSecret(parts.join('.'), key, AAD)).toThrow(DecryptError);
  });

  it('rejects parts that are not canonical base64url', () => {
    const parts = encryptSecret(PLAINTEXT, key, AAD).split('.');
    parts[2] = `${parts[2]}=`;
    expect(() => decryptSecret(parts.join('.'), key, AAD)).toThrow(DecryptError);
    parts[2] = `${parts[2]!.slice(0, -1)}+`;
    expect(() => decryptSecret(parts.join('.'), key, AAD)).toThrow(DecryptError);
  });

  it('rejects a wrong AAD (ciphertext swapped between rows)', () => {
    const token = encryptSecret(PLAINTEXT, key, AAD);
    expect(() => decryptSecret(token, key, 'connection:other')).toThrow(DecryptError);
  });

  it('rejects a wrong key', () => {
    const token = encryptSecret(PLAINTEXT, key, AAD);
    expect(() => decryptSecret(token, randomBytes(32), AAD)).toThrow(DecryptError);
  });

  it.each(['', 'garbage', 'v1.a.b', 'v1.a.b.c.d'])('rejects malformed token %j', (token) => {
    expect(() => decryptSecret(token, key, AAD)).toThrow(DecryptError);
  });

  it('never leaks plaintext, key or token in error messages', () => {
    const token = encryptSecret(PLAINTEXT, key, AAD);
    const messages: string[] = [];
    const attempts = [
      () => decryptSecret(token, randomBytes(32), AAD),
      () => decryptSecret(token, key, 'other'),
      () => decryptSecret(token.replace('v1', 'v9'), key, AAD),
      () => encryptSecret(PLAINTEXT, Buffer.alloc(5), AAD),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (e) {
        messages.push(String(e instanceof Error ? e.message : e));
      }
    }
    expect(messages).toHaveLength(attempts.length);
    for (const m of messages) {
      expect(m).not.toContain(PLAINTEXT);
      expect(m).not.toContain(key.toString('hex'));
      expect(m).not.toContain(token);
    }
  });
});
