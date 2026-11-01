import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ENCRYPTION_KEY_PATTERN } from './env';

// AES-256-GCM envelope: `v1.<iv>.<ciphertext>.<tag>`, each part base64url.
// The caller-supplied `aad` (e.g. `connection:<id>`) is authenticated but not stored, so a
// ciphertext copied to another row fails to decrypt. Error messages never carry secret material.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Thrown when a token is malformed, tampered with, of an unknown version, or the key/AAD is wrong. */
export class DecryptError extends Error {
  constructor() {
    super('Unable to decrypt secret');
    this.name = 'DecryptError';
  }
}

/** Parses ENCRYPTION_KEY: exactly 64 hex chars (32 bytes), case-insensitive. */
export function loadEncryptionKey(hex: string): Buffer {
  if (!ENCRYPTION_KEY_PATTERN.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters');
  }
  return Buffer.from(hex.toLowerCase(), 'hex');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('Encryption key must be 32 bytes');
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** Decodes a canonical base64url part (rejects padding, other alphabets and non-canonical tails). */
function decodePart(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new DecryptError();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new DecryptError();
  return bytes;
}

export function decryptSecret(token: string, key: Buffer, aad: string): string {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || key.length !== KEY_BYTES) {
    throw new DecryptError();
  }
  try {
    const iv = decodePart(parts[1]!);
    const ciphertext = decodePart(parts[2]!);
    const tag = decodePart(parts[3]!);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptError();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptError();
  }
}
