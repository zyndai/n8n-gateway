import { describe, expect, it } from 'vitest';
import { keypairFromSeed, IdentityService } from '../src/services/IdentityService.js';
import { RPC_AUTH_EXPIRED, RPC_AUTH_FAILED, RPC_REPLAY_DETECTED, ZYND_AUTH_KEY, ZyndAuthError, signZyndAuth, verifyZyndAuth, type A2AMessage, type ZyndAuthBlock } from '../src/services/zyndAuth.js';
import { MemoryNonces } from './helpers/memoryStores.js';

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const caller = new IdentityService().deriveKeypair(seed(1), 3);
const msg = (): A2AMessage => ({ kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'data', data: { city: 'Pune' } }] });
const auth = (m: A2AMessage) => m.metadata?.[ZYND_AUTH_KEY] as ZyndAuthBlock;

async function rejection(p: Promise<unknown>): Promise<ZyndAuthError> {
  try {
    await p;
  } catch (e) {
    return e as ZyndAuthError;
  }
  throw new Error('expected a rejection');
}

describe('x-zynd-auth (M2.6)', () => {
  it('accepts a correctly signed message and reports the caller', async () => {
    const m = signZyndAuth(msg(), caller);
    const v = await verifyZyndAuth(m, new MemoryNonces());
    expect(v.entityId).toBe(auth(m).entity_id);
    expect(v.publicKey).toBe(auth(m).public_key);
  });

  it('rejects a replayed nonce (-32101)', async () => {
    const nonces = new MemoryNonces();
    const m = signZyndAuth(msg(), caller);
    await verifyZyndAuth(structuredClone(m), nonces);
    const err = await rejection(verifyZyndAuth(structuredClone(m), nonces));
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.rpcCode).toBe(RPC_REPLAY_DETECTED);
  });

  it('rejects a tampered body (any field under the signature)', async () => {
    const m = signZyndAuth(msg(), caller);
    (m.parts as { data: { city: string } }[])[0]!.data.city = 'Delhi';
    const err = await rejection(verifyZyndAuth(m, new MemoryNonces()));
    expect(err.rpcCode).toBe(RPC_AUTH_FAILED);
    expect(err.message).toMatch(/signature/);
  });

  it('rejects a signature made by a different key', async () => {
    const m = signZyndAuth(msg(), caller);
    const other = signZyndAuth(msg(), new IdentityService().deriveKeypair(seed(9), 0));
    auth(m).signature = auth(other).signature;
    expect((await rejection(verifyZyndAuth(m, new MemoryNonces()))).rpcCode).toBe(RPC_AUTH_FAILED);
  });

  it('rejects an entity_id that does not belong to the public key', async () => {
    const m = signZyndAuth(msg(), caller);
    auth(m).entity_id = 'zns:' + '0'.repeat(32);
    const err = await rejection(verifyZyndAuth(m, new MemoryNonces()));
    expect(err.message).toMatch(/entity_id/);
  });

  it('does not let a forged message burn the real caller\'s nonce', async () => {
    const nonces = new MemoryNonces();
    const real = signZyndAuth(msg(), caller);
    const forged = structuredClone(real);
    (forged.parts as { data: unknown }[])[0]!.data = { evil: true };
    await rejection(verifyZyndAuth(forged, nonces));
    await expect(verifyZyndAuth(real, nonces)).resolves.toBeTruthy();
  });

  it('rejects expired and not-yet-valid auth (-32102)', async () => {
    const past = signZyndAuth(msg(), caller, 60_000, new Date(Date.now() - 120_000));
    expect((await rejection(verifyZyndAuth(past, new MemoryNonces()))).rpcCode).toBe(RPC_AUTH_EXPIRED);
    const future = signZyndAuth(msg(), caller, 60_000, new Date(Date.now() + 10 * 60_000));
    expect((await rejection(verifyZyndAuth(future, new MemoryNonces()))).rpcCode).toBe(RPC_AUTH_EXPIRED);
  });

  it('rejects missing auth, wrong version and over-long lifetimes', async () => {
    expect((await rejection(verifyZyndAuth(msg(), new MemoryNonces()))).rpcCode).toBe(RPC_AUTH_FAILED);
    const v2 = signZyndAuth(msg(), caller);
    auth(v2).v = 2;
    expect((await rejection(verifyZyndAuth(v2, new MemoryNonces()))).message).toMatch(/version/);
    const long = signZyndAuth(msg(), caller, 3_600_000);
    expect((await rejection(verifyZyndAuth(long, new MemoryNonces()))).message).toMatch(/lifetime/);
  });

  it('does not mutate the message it verifies', async () => {
    const m = signZyndAuth(msg(), caller);
    const before = JSON.stringify(m);
    await verifyZyndAuth(m, new MemoryNonces());
    expect(JSON.stringify(m)).toBe(before);
    expect(keypairFromSeed(seed(1)).publicKey.length).toBe(32);
  });
});

describe('x-zynd-auth interop with the TS SDK', () => {
  it('verifies a message signed by zyndai-ts-sdk signMessage()', async () => {
    const fixture = (await import('./fixtures/sdk-signed-message.json', { with: { type: 'json' } })).default as A2AMessage;
    const issued = Date.parse(auth(fixture).issued_at);
    const v = await verifyZyndAuth(fixture, new MemoryNonces(), new Date(issued + 1000));
    expect(v.entityId).toBe(auth(fixture).entity_id);
  });

  it('produces messages the SDK format accepts (same fields, ed25519: prefixed signature)', () => {
    const a = auth(signZyndAuth(msg(), caller));
    expect(Object.keys(a).sort()).toEqual(['entity_id', 'expires_at', 'issued_at', 'nonce', 'public_key', 'signature', 'v']);
    expect(a.signature).toMatch(/^ed25519:/);
    expect(a.public_key).toMatch(/^ed25519:/);
  });
});
