import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { fromHex, privateKeyToAddress, recoverSigner, signDigest, transferAuthorizationDigest } from '../src/services/evm.js';
import { atomicToMicroUsd, formatUsd, microUsdToAtomic, parseUsd } from '../src/services/money.js';
import vectors from './fixtures/x402-vectors.json' with { type: 'json' };

// Vectors were produced by viem (the signer the TS SDK uses): privateKeyToAccount(sha256(seed)).
const priv = sha256(fromHex(vectors.seedHex));
const auth = {
  from: vectors.message.from,
  to: vectors.message.to,
  value: BigInt(vectors.message.value),
  validAfter: BigInt(vectors.message.validAfter),
  validBefore: BigInt(vectors.message.validBefore),
  nonce: vectors.message.nonce,
};
const domain = { ...vectors.domain, chainId: BigInt(vectors.domain.chainId) };

describe('evm primitives vs viem', () => {
  it('derives the same EIP-55 address from sha256(seed)', () => {
    expect(privateKeyToAddress(priv)).toBe(vectors.address);
  });

  it('produces the identical EIP-712 signature (deterministic RFC 6979)', () => {
    expect(signDigest(priv, transferAuthorizationDigest(domain, auth))).toBe(vectors.signature);
  });

  it('recovers the signer from a viem signature', () => {
    expect(recoverSigner(transferAuthorizationDigest(domain, auth), vectors.signature)).toBe(vectors.address);
  });

  it('does not recover the signer when any signed field changes', () => {
    const tampered = transferAuthorizationDigest(domain, { ...auth, value: auth.value + 1n });
    expect(recoverSigner(tampered, vectors.signature)).not.toBe(vectors.address);
  });

  it('rejects malformed signatures', () => {
    const d = transferAuthorizationDigest(domain, auth);
    expect(recoverSigner(d, '0x1234')).toBeUndefined();
    expect(recoverSigner(d, vectors.signature.slice(0, -2) + '05')).toBeUndefined();
  });
});

describe('money', () => {
  it('round-trips USD strings without float error', () => {
    expect(parseUsd('0.05')).toBe(50000n);
    expect(formatUsd(parseUsd('0.1') + parseUsd('0.2'))).toBe('0.300000');
    expect(parseUsd('12')).toBe(12_000_000n);
  });
  it('rejects bad amounts', () => {
    for (const bad of ['-1', '1e3', '0.0000001', '', 'abc', '1,5']) expect(() => parseUsd(bad)).toThrow();
  });
  it('converts token atomic units, rounding up when decimals exceed 6', () => {
    expect(atomicToMicroUsd(50000n, 6)).toBe(50000n);
    expect(atomicToMicroUsd(1n, 18)).toBe(1n);
    expect(microUsdToAtomic(50000n, 6)).toBe(50000n);
    expect(microUsdToAtomic(1n, 18)).toBe(10n ** 12n);
  });
});
