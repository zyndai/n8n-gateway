// M5.6: end-to-end paid-call latency, PRD target p50 < 2 s.
//
//   npx tsx scripts/measure-latency.ts
//   (CALLS, WARMUP, FACILITATOR_MS, N8N_MS, P50_BUDGET_MS tune the run)
//
// Runs the real Gateway (routes, A2A handler, x402 verify and settle, webhook forwarder, task
// store, TaskWaiter) in-process over loopback HTTP, with a fake n8n and a fake facilitator that
// each wait the given number of milliseconds. A paid call is what an external agent does:
// unsigned request -> 402 -> signed payment -> result. Two shapes are timed:
//   sync   the webhook answers with `output`, the job finishes at once (G2)
//   async  the webhook answers 200 and the workflow calls /jobs/complete N8N_MS later
// So the figure is the Gateway's own cost plus the delays you give it. It does not include a real
// facilitator, real n8n or the network to staging: that run is still open (M5.6 on staging).
// Exit code 1 if either p50 is over the budget.
import type { ServerResponse } from 'node:http';
import { makeGateway, API_KEY } from '../test/helpers/harness.js';
import { signZyndAuth } from '../src/services/zyndAuth.js';
import type { PaymentRequirements } from '../src/services/PaymentProcessor.js';

const CALLS = Number(process.env.CALLS ?? 200);
const WARMUP = Number(process.env.WARMUP ?? 20);
const FACILITATOR_MS = Number(process.env.FACILITATOR_MS ?? 150);
const N8N_MS = Number(process.env.N8N_MS ?? 100);
const BUDGET_MS = Number(process.env.P50_BUDGET_MS ?? 2000);
const payerSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);

const gw = await makeGateway({ price: '0.05', listen: true, facilitatorDelayMs: FACILITATOR_MS, timeoutMs: 30_000 });
const url = `${gw.publicUrl}/a/${encodeURIComponent(gw.entityId)}/a2a/v1`;

async function rpc(headers: Record<string, string>): Promise<Response> {
  const message = gw.message();
  signZyndAuth(message, gw.callerKey);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(gw.rpc('tasks/send', { message })) });
}

async function paidCall(): Promise<number> {
  const t0 = performance.now();
  const challenge = await rpc({});
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`);
  const header = JSON.parse(Buffer.from(challenge.headers.get('payment-required') as string, 'base64').toString('utf8'));
  const sig = gw.payments.signX402(payerSeed, header.accepts[0] as PaymentRequirements).headers['PAYMENT-SIGNATURE'] as string;
  const res = await rpc({ 'PAYMENT-SIGNATURE': sig });
  const body = (await res.json()) as { result?: { status?: { state?: string } } };
  const ms = performance.now() - t0;
  if (res.status !== 200 || body.result?.status?.state !== 'completed') throw new Error(`paid call failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return ms;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;

async function run(label: string): Promise<boolean> {
  for (let i = 0; i < WARMUP; i++) await paidCall();
  const times: number[] = [];
  for (let i = 0; i < CALLS; i++) times.push(await paidCall());
  times.sort((a, b) => a - b);
  const p50 = pct(times, 50);
  const ok = p50 < BUDGET_MS;
  console.log(
    `${label.padEnd(6)} n=${CALLS}  p50=${p50.toFixed(0)} ms  p95=${pct(times, 95).toFixed(0)} ms  p99=${pct(times, 99).toFixed(0)} ms  max=${times[times.length - 1]!.toFixed(0)} ms  ${ok ? 'OK' : 'OVER BUDGET'}`,
  );
  return ok;
}

console.log(`paid call, facilitator ${FACILITATOR_MS} ms per hop (verify + settle), n8n ${N8N_MS} ms, budget p50 < ${BUDGET_MS} ms`);

gw.n8n.respond = (_job, res: ServerResponse) => {
  setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"output":{"ok":true}}'), N8N_MS);
};
const syncOk = await run('sync');

gw.n8n.respond = (job, res: ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"message":"Workflow was started"}');
  setTimeout(() => {
    void gw.post(`/n8n/v1/jobs/${job.payload.jobId}/complete`, { output: { ok: true } }, API_KEY).then(() => undefined);
  }, N8N_MS);
};
const asyncOk = await run('async');

await gw.close();
process.exit(syncOk && asyncOk ? 0 : 1);
