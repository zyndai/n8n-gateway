// AES-256-GCM at rest, byte-compatible with the dashboard's `encryptPrivateKey` /
// `decryptPrivateKey` (dashboard/src/lib/pki.ts): base64(iv[12] || authTag[16] || ciphertext)
// under the 32-byte `PKI_ENCRYPTION_KEY`. Used for developer keys (read) and for the webhook
// secret (G1: written and read here).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';

const IV_LEN = 12;
const TAG_LEN = 16;

/** Parse the 64-hex-char master key. Throws a generic INTERNAL error, never echoing the value. */
export function parseMasterKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ApiError('INTERNAL', 'PKI_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(ciphertextB64: string, masterKey: Buffer): string {
  const combined = Buffer.from(ciphertextB64, 'base64');
  if (combined.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = combined.subarray(0, IV_LEN);
  const tag = combined.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = combined.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
