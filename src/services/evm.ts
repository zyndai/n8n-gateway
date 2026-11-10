// Minimal EVM primitives for x402 "exact" payments, built on @noble only (viem would add ~50 MB
// to node_modules and a lot to the bundle). Covers: secp256k1 key -> address (EIP-55),
// EIP-712 hashing of EIP-3009 `TransferWithAuthorization`, signing and signer recovery.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const hex = (b: Uint8Array): string => `0x${bytesToHex(b)}`;

export function fromHex(h: string): Uint8Array {
  return hexToBytes(h.startsWith('0x') ? h.slice(2) : h);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const word = (n: bigint): Uint8Array => fromHex(n.toString(16).padStart(64, '0'));
const addressWord = (addr: string): Uint8Array => concat(new Uint8Array(12), fromHex(addr));

/** EIP-55 checksum address from 20 raw address bytes. */
export function toChecksumAddress(raw: Uint8Array): string {
  const lower = bytesToHex(raw);
  const h = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(h[i] as string, 16) >= 8 ? (lower[i] as string).toUpperCase() : lower[i];
  return out;
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function addressFromPublicKey(uncompressed: Uint8Array): string {
  return toChecksumAddress(keccak_256(uncompressed.slice(1)).slice(-20));
}

export function privateKeyToAddress(privateKey: Uint8Array): string {
  return addressFromPublicKey(secp256k1.getPublicKey(privateKey, false));
}

export interface Eip3009Domain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}

export interface TransferAuthorization {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** 0x-prefixed 32 bytes. */
  nonce: string;
}

const DOMAIN_TYPEHASH = keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TRANSFER_TYPEHASH = keccak_256(
  utf8ToBytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'),
);

/** The 32-byte digest an EIP-3009 token expects to be signed. */
export function transferAuthorizationDigest(domain: Eip3009Domain, auth: TransferAuthorization): Uint8Array {
  const domainSeparator = keccak_256(
    concat(
      DOMAIN_TYPEHASH,
      keccak_256(utf8ToBytes(domain.name)),
      keccak_256(utf8ToBytes(domain.version)),
      word(domain.chainId),
      addressWord(domain.verifyingContract),
    ),
  );
  const structHash = keccak_256(
    concat(TRANSFER_TYPEHASH, addressWord(auth.from), addressWord(auth.to), word(auth.value), word(auth.validAfter), word(auth.validBefore), fromHex(auth.nonce)),
  );
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

/** 65-byte `r ‖ s ‖ v` (v = 27/28), the form EIP-3009 `transferWithAuthorization(bytes)` accepts. */
export function signDigest(privateKey: Uint8Array, digest: Uint8Array): string {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
  // noble's "recovered" format is recovery byte first, then r ‖ s.
  const recovery = sig[0] as number;
  return hex(concat(sig.slice(1), new Uint8Array([27 + recovery])));
}

/** Address that produced `signature` over `digest`; undefined for a malformed signature. */
export function recoverSigner(digest: Uint8Array, signature: string): string | undefined {
  try {
    const raw = fromHex(signature);
    if (raw.length !== 65) return undefined;
    const v = raw[64] as number;
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return undefined;
    const pub = secp256k1.recoverPublicKey(concat(new Uint8Array([recovery]), raw.slice(0, 64)), digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    return addressFromPublicKey(uncompressed);
  } catch {
    return undefined;
  }
}
