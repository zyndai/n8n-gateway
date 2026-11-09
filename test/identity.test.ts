// Interop: every expected value in test/fixtures/sdk-vectors.json was produced by the reference
// TS SDK (zyndai-ts-sdk: deriveAgentKeypair, createDerivationProof, canonicalJson, sign) with the
// developer seed 0x01..0x20. Ed25519 is deterministic, so signatures must match byte for byte.
import { ed25519 } from '@noble/curves/ed25519.js';
import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { canonicalJson } from '../src/services/canonical.js';
import {
  IdentityService,
  entityIdFor,
  keypairFromSeed,
  publicKeyString,
  type DeveloperKeyRecord,
} from '../src/services/IdentityService.js';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import vectors from './fixtures/sdk-vectors.json' with { type: 'json' };

const devSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const identity = new IdentityService();

describe('deriveKeypair (M1.1)', () => {
  for (const c of vectors.cases) {
    it(`matches the SDK at index ${c.index}`, () => {
      const agent = identity.deriveKeypair(devSeed, c.index);
      expect(publicKeyString(agent.publicKey)).toBe(c.agentPublic);
      expect(entityIdFor(agent.publicKey)).toBe(c.entityId);
    });
  }

  it('is deterministic per index and distinct across indexes', () => {
    const a1 = identity.deriveKeypair(devSeed, 3);
    const a2 = identity.deriveKeypair(devSeed, 3);
    const b = identity.deriveKeypair(devSeed, 4);
    expect(b64(a1.publicKey)).toBe(b64(a2.publicKey));
    expect(b64(a1.publicKey)).not.toBe(b64(b.publicKey));
  });

  it('rejects out-of-range indexes and bad seeds', () => {
    expect(() => identity.deriveKeypair(devSeed, -1)).toThrow(RangeError);
    expect(() => identity.deriveKeypair(devSeed, 2 ** 32)).toThrow(RangeError);
    expect(() => identity.deriveKeypair(new Uint8Array(31), 0)).toThrow(RangeError);
  });
});

describe('createDerivationProof (M1.4)', () => {
  const dev = keypairFromSeed(devSeed);
  it('has the developer public key from the SDK', () => {
    expect(publicKeyString(dev.publicKey)).toBe(vectors.devPublic);
  });
  for (const c of vectors.cases) {
    it(`matches the SDK proof at index ${c.index}`, () => {
      const agent = identity.deriveKeypair(devSeed, c.index);
      const proof = identity.createDerivationProof(dev, agent, c.index);
      expect(proof).toEqual(c.proof);
      // AgentDNS verifies: dev signature over agentPub || uint32_be(index)
      const msg = new Uint8Array(36);
      msg.set(agent.publicKey);
      new DataView(msg.buffer).setUint32(32, c.index, false);
      const sig = Buffer.from(proof.developer_signature.slice(8), 'base64');
      expect(ed25519.verify(sig, msg, dev.publicKey)).toBe(true);
    });
  }
});

describe('signRegistration (M1.4)', () => {
  it('produces the SDK canonical JSON and signature', () => {
    const agent = identity.deriveKeypair(devSeed, vectors.registration.agentIndex);
    const signed = identity.signRegistration(agent, {
      name: 'Weather ☀ bot',
      entity_url: `https://gw.zynd.ai/a/${entityIdFor(agent.publicKey)}`,
      category: 'general',
      summary: 'Forecasts "quoted" & <tags>',
      tags: ['b', 'a'],
    });
    expect(signed.canonicalJson).toBe(vectors.registration.canonicalJson);
    expect(signed.signature).toBe(vectors.registration.signature);
  });

  it('includes entity_type only when set', () => {
    const agent = identity.deriveKeypair(devSeed, 1);
    const base = { name: 'n', entity_url: 'u', category: 'c', summary: 's', tags: [] };
    expect(identity.signRegistration(agent, base).canonicalJson).not.toContain('entity_type');
    expect(identity.signRegistration(agent, { ...base, entity_type: 'service' }).canonicalJson).toContain('"entity_type":"service"');
  });
});

describe('signHeartbeat (M1.5)', () => {
  it('matches the SDK signature over the timestamp bytes', () => {
    const agent = identity.deriveKeypair(devSeed, 7);
    const hb = identity.signHeartbeat(agent, new Date('2026-11-10T02:30:00Z'));
    expect(hb).toEqual(vectors.heartbeat);
  });

  it('emits second-precision RFC 3339 (no milliseconds) that verifies', () => {
    const agent = identity.deriveKeypair(devSeed, 7);
    const hb = identity.signHeartbeat(agent, new Date('2026-11-10T02:30:00.789Z'));
    expect(hb.timestamp).toBe('2026-11-10T02:30:00Z');
    const sig = Buffer.from(hb.signature.slice(8), 'base64');
    expect(ed25519.verify(sig, new TextEncoder().encode(hb.timestamp), agent.publicKey)).toBe(true);
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops whitespace, normalises -0', () => {
    expect(canonicalJson({ b: [1, { z: 1, a: 2 }], a: null, c: -0 })).toBe('{"a":null,"b":[1,{"a":2,"z":1}],"c":0}');
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('keyVault (dashboard pki.ts compatibility)', () => {
  const masterKey = parseMasterKey('ab'.repeat(32));

  // Independent re-implementation of dashboard/src/lib/pki.ts encryptPrivateKey.
  function dashboardEncrypt(plain: string): string {
    const iv = Buffer.alloc(12, 7);
    const c = createCipheriv('aes-256-gcm', masterKey, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }

  it('decrypts what the dashboard encrypts', () => {
    expect(decryptSecret(dashboardEncrypt('hello'), masterKey)).toBe('hello');
  });
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('s3cret', masterKey);
    expect(decryptSecret(a, masterKey)).toBe('s3cret');
    expect(encryptSecret('s3cret', masterKey)).not.toBe(a);
  });
  it('rejects tampering and the wrong key', () => {
    const ct = Buffer.from(encryptSecret('x', masterKey), 'base64');
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(ct.toString('base64'), masterKey)).toThrow();
    expect(() => decryptSecret(encryptSecret('x', masterKey), parseMasterKey('cd'.repeat(32)))).toThrow();
  });
  it('validates the master key without echoing it', () => {
    expect(() => parseMasterKey(undefined)).toThrow(ApiError);
    expect(() => parseMasterKey('zz'.repeat(32))).toThrow(/64-character hex/);
    expect(() => parseMasterKey('abcd')).toThrow(/64-character hex/);
  });
});

describe('developer key loading + keypair cache (M1.1, M1.3)', () => {
  const masterKey = parseMasterKey('ab'.repeat(32));
  const devPublic = b64(keypairFromSeed(devSeed).publicKey);

  function setup(rec: Partial<DeveloperKeyRecord> | null, plaintext: string = b64(devSeed)) {
    let calls = 0;
    const svc = new IdentityService({
      masterKey,
      keySource: {
        async getDeveloperKey() {
          calls++;
          if (rec === null) return undefined;
          return { privateKeyEnc: encryptSecret(plaintext, masterKey), publicKey: `ed25519:${devPublic}`, ...rec };
        },
      },
    });
    return { svc, calls: () => calls };
  }
  const ref = { listingId: 'L1', developerId: 'zns:dev:1', derivedKeyIndex: 7 };

  it('derives the SDK agent key from a decrypted 32-byte seed', async () => {
    const { svc } = setup({});
    const kp = await svc.getListingKeypair(ref);
    expect(publicKeyString(kp.publicKey)).toBe(vectors.cases[1]?.agentPublic);
  });

  it('accepts a 64-byte seed||public key and an ed25519: prefix', async () => {
    const full = Buffer.concat([devSeed, keypairFromSeed(devSeed).publicKey]);
    const { svc } = setup({}, `ed25519:${full.toString('base64')}`);
    const kp = await svc.getListingKeypair(ref);
    expect(publicKeyString(kp.publicKey)).toBe(vectors.cases[1]?.agentPublic);
  });

  it('does no decryption on the second call, and shares one load between concurrent first calls', async () => {
    const { svc, calls } = setup({});
    const [a, b] = await Promise.all([svc.getListingKeypair(ref), svc.getListingKeypair(ref)]);
    expect(a).toBe(b);
    await svc.getListingKeypair(ref);
    expect(calls()).toBe(1);
  });

  it('reloads after invalidate / invalidateDeveloper', async () => {
    const { svc, calls } = setup({});
    await svc.getListingKeypair(ref);
    svc.invalidate('L1');
    await svc.getListingKeypair(ref);
    expect(calls()).toBe(2);
    svc.invalidateDeveloper('zns:dev:1');
    expect(svc.cacheSize).toBe(0);
    await svc.getListingKeypair(ref);
    expect(calls()).toBe(3);
  });

  it('does not cache failures', async () => {
    const { svc, calls } = setup(null);
    await expect(svc.getListingKeypair(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.getListingKeypair(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls()).toBe(2);
    expect(svc.cacheSize).toBe(0);
  });

  it('rejects a key that does not match the stored public key, without leaking material', async () => {
    const { svc } = setup({ publicKey: `ed25519:${b64(new Uint8Array(32).fill(9))}` });
    const err = await svc.getListingKeypair(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(JSON.stringify((err as ApiError).toBody())).not.toContain(b64(devSeed));
  });

  it('rejects undecryptable or wrong-length keys with a generic error', async () => {
    const { svc } = setup({ privateKeyEnc: 'AAAA' });
    await expect(svc.getListingKeypair(ref)).rejects.toMatchObject({ code: 'INTERNAL' });
    const { svc: svc2 } = setup({}, b64(new Uint8Array(20)));
    await expect(svc2.getListingKeypair(ref)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('zeroes the developer key after use', async () => {
    const { svc } = setup({});
    let captured: Uint8Array | undefined;
    await svc.withDeveloperKeypair('zns:dev:1', (dev) => {
      captured = dev.privateKey;
      expect(captured.some((b) => b !== 0)).toBe(true);
    });
    expect(captured?.every((b) => b === 0)).toBe(true);
  });
});
