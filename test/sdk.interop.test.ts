// M2.21: the real zyndai-ts-sdk client against a Gateway listing over real HTTP: card discovery from
// entity_url, x-zynd-auth signed by the SDK, the call, the result, and the 402 an unpaid caller gets.
// The SDK is a sibling checkout (../zyndai-ts-sdk, built); without it these tests are skipped.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEV, devSeed, makeGateway, type Gateway } from './helpers/harness.js';

const sdkEntry = resolve(import.meta.dirname, '../../zyndai-ts-sdk/dist/index.mjs');
const hasSdk = existsSync(sdkEntry);
// G19: SDK builds from before the payment support have no A2APayer; the paid-call tests need it.
const sdkCanPay = hasSdk && readFileSync(sdkEntry, 'utf8').includes('A2APayer');
const pySdk = resolve(import.meta.dirname, '../../zyndai-agent');
const pyBin = resolve(pySdk, '.venv/bin/python');
const pyCanPay = existsSync(pyBin) && existsSync(resolve(pySdk, 'zyndai_agent/a2a/payment_client.py'));

interface Keypair {
  privateKeyBytes: Uint8Array;
  entityId: string;
}
interface Sdk {
  A2AClient: new (o: { keypair: Keypair; entityId: string; payment?: true | { maxPaymentUsd?: number } }) => {
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

// G19: the SDK clients pay a 402. The Gateway's own verifier (recovers the EIP-712 signer, checks amount,
// recipient and validity window) must accept what the SDKs sign, and the Gateway must charge exactly once.
describe.skipIf(!sdkCanPay)('zyndai-ts-sdk client pays a paid listing (G19)', () => {
  const paid = (g: Gateway) => g.n8n.respond = (_job, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: 'Sunny' }));

  it('pays the 402, gets the result, and the facilitator is called once to verify and once to settle', async () => {
    gw = await makeGateway({ listen: true, price: '0.05' });
    paid(gw);
    const keypair = sdk.generateKeypair();
    const client = new sdk.A2AClient({ keypair, entityId: keypair.entityId, payment: { maxPaymentUsd: 0.1 } });

    expect(await client.ask(gw.listing.entityUrl as string, 'hi', { timeoutMs: 10_000 })).toBe('Sunny');
    expect(gw.fac.calls).toEqual(['verify', 'settle']);
  });

  it('refuses a price above its cap before signing anything', async () => {
    gw = await makeGateway({ listen: true, price: '0.50' });
    const keypair = sdk.generateKeypair();
    const client = new sdk.A2AClient({ keypair, entityId: keypair.entityId, payment: true });

    await expect(client.ask(gw.listing.entityUrl as string, 'hi', { timeoutMs: 10_000 })).rejects.toThrow(/Refusing to pay/);
    expect(gw.fac.calls).toEqual([]);
    expect(gw.jobs).toHaveLength(0);
  });
});

describe.skipIf(!pyCanPay)('zyndai-python-sdk client pays a paid listing (G19)', () => {
  const run = promisify(execFile);
  const script = (url: string, cap: number) => `
from zyndai_agent.a2a.client import A2AClient
from zyndai_agent.a2a.payment_client import ClientPaymentOptions
from zyndai_agent.ed25519_identity import generate_keypair
kp = generate_keypair()
c = A2AClient(kp, kp.entity_id, payment=ClientPaymentOptions(max_payment_usd=${cap}))
print("REPLY:" + c.ask("${url}", "hi"))
`;

  it('pays the 402 and gets the result; the Gateway verifies and settles once', async () => {
    gw = await makeGateway({ listen: true, price: '0.05' });
    gw.n8n.respond = (_job, res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: 'Sunny' }));
    const { stdout } = await run(pyBin, ['-c', script(gw.listing.entityUrl as string, 0.1)], { cwd: pySdk, timeout: 60_000 });
    expect(stdout).toContain('REPLY:Sunny');
    expect(gw.fac.calls).toEqual(['verify', 'settle']);
  });

  it('refuses a price above its cap before signing anything', async () => {
    gw = await makeGateway({ listen: true, price: '0.50' });
    await expect(run(pyBin, ['-c', script(gw.listing.entityUrl as string, 0.1)], { cwd: pySdk, timeout: 60_000 })).rejects.toThrow(/Refusing to pay/);
    expect(gw.fac.calls).toEqual([]);
    expect(gw.jobs).toHaveLength(0);
  });
});
