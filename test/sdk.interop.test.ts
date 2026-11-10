// M2.21: the real zyndai-ts-sdk client against a Gateway listing over real HTTP: card discovery from
// entity_url, x-zynd-auth signed by the SDK, the call, the result, and the 402 an unpaid caller gets.
// The SDK is a sibling checkout (../zyndai-ts-sdk, built); without it these tests are skipped.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEV, devSeed, makeGateway, type Gateway } from './helpers/harness.js';

const sdkEntry = resolve(import.meta.dirname, '../../zyndai-ts-sdk/dist/index.mjs');
const hasSdk = existsSync(sdkEntry);

interface Keypair {
  privateKeyBytes: Uint8Array;
  entityId: string;
}
interface Sdk {
  A2AClient: new (o: { keypair: Keypair; entityId: string }) => {
    ask(target: string, text: string, o?: { data?: Record<string, unknown>; timeoutMs?: number }): Promise<string>;
    sync(o: { url: string; text?: string; data?: Record<string, unknown>; timeoutMs?: number }): Promise<{ status: { state: string }; artifacts?: { parts: unknown[] }[] }>;
  };
  generateKeypair(): Keypair;
  deriveAgentKeypair(dev: Uint8Array, index: number): Keypair;
  X402PaymentProcessor: new (o: { ed25519PrivateKeyBytes: Uint8Array }) => { address: string };
}
let sdk: Sdk;
let gw: Gateway | undefined;

beforeAll(async () => {
  if (hasSdk) sdk = (await import(pathToFileURL(sdkEntry).href)) as Sdk;
});
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
const clientFor = () => {
  const keypair = sdk.generateKeypair();
  return new sdk.A2AClient({ keypair, entityId: keypair.entityId });
};
/** Whatever the SDK sends, the workflow answers this way. */
const answer = (g: Gateway, output: unknown) => {
  g.n8n.respond = (_job, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output }));
};

describe.skipIf(!hasSdk)('zyndai-ts-sdk client against the Gateway (M2.21)', () => {
  it('ask(entity_url): resolves the card, signs, calls and returns the workflow output (free listing)', async () => {
    gw = await makeGateway({ listen: true });
    answer(gw, 'Sunny in Pune');
    expect(gw.listing.entityUrl).toBe(`${gw.publicUrl}/a/${gw.entityId}`);

    const reply = await clientFor().ask(gw.listing.entityUrl as string, 'weather in Pune?', { timeoutMs: 10_000 });

    expect(reply).toBe('Sunny in Pune');
    const job = await gw.waitForJob();
    expect(job.payload).toMatchObject({ entityId: gw.entityId, input: 'weather in Pune?' });
    expect(job.payload.caller).toMatch(/^zns:/); // the SDK caller's entity id, verified from its signature
  });

  it('delivers a structured payload and a result that arrives later through jobs/complete', async () => {
    gw = await makeGateway({ listen: true });
    const pending = clientFor().sync({ url: `${gw.listing.entityUrl}/a2a/v1`, data: { city: 'Pune' }, timeoutMs: 10_000 });
    const job = await gw.waitForJob();
    expect(job.payload.input).toEqual({ city: 'Pune' });
    await gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: { forecast: 'sunny' } });

    const task = await pending;
    expect(task.status.state).toBe('completed');
    expect(task.artifacts?.[0]?.parts).toEqual([{ kind: 'data', data: { forecast: 'sunny' } }]);
  });

  it('is refused with 402 and a PAYMENT-REQUIRED challenge when the listing is paid and the caller does not pay', async () => {
    gw = await makeGateway({ listen: true, price: '0.05' });
    await expect(clientFor().ask(gw.listing.entityUrl as string, 'hi', { timeoutMs: 10_000 })).rejects.toThrow(/HTTP 402/);
    expect(gw.jobs).toHaveLength(0);

    // The challenge a payer would answer, fetched as the SDK client would send the call.
    const challenge = await gw.send();
    const [req] = decode(challenge.headers['payment-required'] as string).accepts as { payTo: string; amount: string }[];
    // payTo is the EVM address of the SDK-derived agent key: same derivation on both sides.
    const agentKey = sdk.deriveAgentKeypair(devSeed, gw.listing.derivedKeyIndex);
    expect(req?.payTo).toBe(new sdk.X402PaymentProcessor({ ed25519PrivateKeyBytes: agentKey.privateKeyBytes }).address);
    expect(req?.amount).toBe('50000');
  });

  it('gets an error, not a result, for a listing that is not active', async () => {
    gw = await makeGateway({ listen: true });
    await gw.listings.deactivate(DEV, gw.listing.id);
    await expect(clientFor().ask(gw.listing.entityUrl as string, 'hi', { timeoutMs: 10_000 })).rejects.toThrow(/409|not active/i);
  });
});
