// M1.14: Gateway memory with a live Postgres pool and N simulated heartbeat sockets (default 200).
//
//   npm run build
//   DATABASE_URL=postgresql://... npm run measure:memory
//   (SOCKETS, HOLD_S, LOAD_SINGLE, LOAD_LISTS, GATEWAY_NODE_FLAGS, TIMELINE tune the run)
//
// DATABASE_URL needs the Gateway migrations plus the dashboard's developer_keys table. The script
// seeds N registered, webhook-bound listings against an in-process fake AgentDNS, boots the
// BUNDLED Gateway (`dist/index.mjs`, 96 MB heap cap, exactly as `npm start`) so it recovers them
// through the real M1.11 path, holds the sockets across several beat intervals, then loads the
// dashboard API at 40 concurrency. RSS is sampled from `ps`. Exit code 1 if the budget is missed.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { eq, inArray } from 'drizzle-orm';
import { developerKey } from '../src/db/dashboard.js';
import { disconnectDb, getDb } from '../src/db/client.js';
import { n8nDerivationCounter, n8nHeartbeat, n8nListing } from '../src/db/schema.js';
import { AgentDnsClient } from '../src/services/AgentDnsClient.js';
import { IdentityService, keypairFromSeed, publicKeyString } from '../src/services/IdentityService.js';
import { ListingService } from '../src/services/ListingService.js';
import { ListingStore } from '../src/services/ListingStore.js';
import { encryptSecret, parseMasterKey } from '../src/services/keyVault.js';
import { FakeAgentDns } from '../test/helpers/fakeAgentDns.js';

const N = Number(process.env.SOCKETS ?? 200);
const PORT = 18081;
// Budget revised from 80/100 MB in M1.14 after measuring 200 live sockets (see PRD > NFRs).
const IDLE_BUDGET_MB = Number(process.env.IDLE_BUDGET_MB ?? 95);
const PEAK_BUDGET_MB = Number(process.env.PEAK_BUDGET_MB ?? 110);
const HOLD_S = Number(process.env.HOLD_S ?? 70); // > two 30 s beat intervals
const LOAD_SINGLE = Number(process.env.LOAD_SINGLE ?? 6000); // GET /listings/:id requests at 40 concurrency
const LOAD_LISTS = Number(process.env.LOAD_LISTS ?? 200); // GET /listings (all N, ~100 KB) at 10 concurrency
const silent = { info: () => {}, warn: () => {}, error: () => {} };

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const masterHex = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const devSeed = randomBytes(32);
const developerId = `zns:dev:mem_${Date.now()}`;
const mintJwt = () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'HS256', typ: 'JWT' });
  const p = enc({ sub: developerId, exp: Math.floor(Date.now() / 1000) + 600 });
  return `${h}.${p}.${createHmac('sha256', jwtSecret).update(`${h}.${p}`).digest('base64url')}`;
};

const rssMb = (pid: number) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function pool<T>(count: number, concurrency: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) out[next] = await fn(next++);
    }),
  );
  return out;
}

const dns = new FakeAgentDns();
await dns.listen();
const store = new ListingStore(getDb());
const ids: string[] = [];
let gateway: ReturnType<typeof spawn> | undefined;

try {
  // --- seed: N registered, webhook-bound listings (no sockets opened by this process) --------
  const masterKey = parseMasterKey(masterHex);
  dns.developers.set(developerId, publicKeyString(keypairFromSeed(devSeed).publicKey));
  await getDb().insert(developerKey).values({
    id: randomUUID(), userId: `u_${developerId}`, developerId,
    publicKey: publicKeyString(keypairFromSeed(devSeed).publicKey),
    privateKeyEnc: encryptSecret(devSeed.toString('base64'), masterKey), name: 'memory test',
  });
  const identity = new IdentityService({ masterKey, keySource: store });
  const seeder = new ListingService({
    store, identity, agentDns: new AgentDnsClient(dns.url), heartbeats: { start() {}, stop: async () => {} },
    publicUrl: 'https://gw.test', heartbeatRequiresWebhook: false, log: silent,
  });
  for (let i = 0; i < N; i++) {
    const l = await seeder.create(developerId, { name: `mem-${i}`, summary: 's', category: 'general', tags: ['m'] });
    await seeder.activate(developerId, l.id);
    ids.push(l.id);
  }
  await getDb().update(n8nListing).set({ webhookUrl: 'https://n8n.test/hook' }).where(eq(n8nListing.developerId, developerId));
  console.log(`seeded ${N} registered listings; registry holds ${dns.entities.size} entities`);

  // --- boot the bundled gateway ----------------------------------------------------------------
  const nodeFlags = (process.env.GATEWAY_NODE_FLAGS ?? '--max-old-space-size=96 --max-semi-space-size=2 --optimize-for-size').split(/\s+/).filter(Boolean);
  gateway = spawn('node', [...nodeFlags, 'dist/index.mjs'], {
    env: {
      ...process.env, PORT: String(PORT), DATABASE_URL: process.env.DATABASE_URL, PKI_ENCRYPTION_KEY: masterHex,
      SESSION_JWT_SECRET: jwtSecret, AGENTDNS_URL: dns.url, PUBLIC_URL: 'https://gw.test', NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  gateway.stdout?.on('data', (d) => (log += d));
  gateway.stderr?.on('data', (d) => (log += d));
  let exited: number | null | undefined;
  gateway.on('exit', (c) => (exited = c));
  const pid = gateway.pid as number;

  const t0 = Date.now();
  while (dns.sockets.size < N) {
    if (exited !== undefined) throw new Error(`gateway exited (${exited}) before sockets connected:\n${log}`);
    if (Date.now() - t0 > 60_000) throw new Error(`only ${dns.sockets.size}/${N} sockets after 60 s:\n${log}`);
    await sleep(100);
  }
  console.log(`${dns.sockets.size} heartbeat sockets connected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // --- hold: idle with N live sockets across several beat intervals -----------------------------
  const samples: number[] = [];
  let peak = 0;
  let phase: 'startup' | 'hold' | 'load' = 'startup';
  const phasePeak = { startup: 0, hold: 0, load: 0 };
  const sampler = setInterval(() => {
    const m = rssMb(pid);
    peak = Math.max(peak, m);
    phasePeak[phase] = Math.max(phasePeak[phase], m);
    samples.push(m);
  }, 250);
  await sleep(3000); // let startup recovery settle before calling it the hold phase
  phase = 'hold';
  console.log(`holding ${HOLD_S} s (beats every 30 s)...`);
  await sleep(HOLD_S * 1000);
  if (process.env.TIMELINE) console.log('rss timeline (MB, every 5 s):', samples.filter((_, i) => i % 20 === 0).map((m) => Math.round(m)).join(' '));
  const idleSamples = samples.slice(-80); // last 20 s
  const idle = median(idleSamples);
  phase = 'load';
  const beats = dns.validBeats;

  // --- load: dashboard API at 40 concurrency with the 200 sockets still beating ------------------
  const jwt = mintJwt();
  const headers = { Authorization: `Bearer ${jwt}` };
  const base = `http://127.0.0.1:${PORT}`;
  const lt = Date.now();
  const statuses = await pool(LOAD_SINGLE, 40, async (i) => (await fetch(`${base}/internal/v1/listings/${ids[i % ids.length]}`, { headers })).status);
  const lists = await pool(LOAD_LISTS, 10, async () => (await (await fetch(`${base}/internal/v1/listings`, { headers })).arrayBuffer()).byteLength);
  const loadS = (Date.now() - lt) / 1000;
  await sleep(1500);
  clearInterval(sampler);

  const ok = statuses.filter((s) => s === 200).length;
  const result = {
    sockets: dns.sockets.size, validBeatsDuringHold: beats, invalidBeats: dns.invalidBeats,
    idleRssMb: Number(idle.toFixed(1)),
    peakRssMb: { startup: Number(phasePeak.startup.toFixed(1)), hold: Number(phasePeak.hold.toFixed(1)), load: Number(phasePeak.load.toFixed(1)), overall: Number(peak.toFixed(1)) },
    load: { requests: LOAD_SINGLE, ok, listCalls: LOAD_LISTS, listBytes: lists[0] ?? 0, seconds: Number(loadS.toFixed(1)) },
    gatewayExited: exited ?? null,
  };
  console.log(JSON.stringify(result, null, 2));

  const failures: string[] = [];
  if (idle > IDLE_BUDGET_MB) failures.push(`idle ${idle.toFixed(1)} MB > ${IDLE_BUDGET_MB} MB`);
  if (peak > PEAK_BUDGET_MB) failures.push(`peak ${peak.toFixed(1)} MB > ${PEAK_BUDGET_MB} MB`);
  if (ok !== LOAD_SINGLE) failures.push(`only ${ok}/${LOAD_SINGLE} requests returned 200`);
  if (exited !== undefined) failures.push(`gateway exited (${exited})`);
  if (dns.invalidBeats > 0) failures.push(`${dns.invalidBeats} invalid heartbeats`);
  console.log(failures.length ? `BUDGET MISSED: ${failures.join('; ')}` : `WITHIN BUDGET (idle <= ${IDLE_BUDGET_MB} MB, peak <= ${PEAK_BUDGET_MB} MB)`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  gateway?.kill('SIGTERM');
  await sleep(500);
  const db = getDb();
  if (ids.length) await db.delete(n8nHeartbeat).where(inArray(n8nHeartbeat.listingId, ids));
  await db.delete(n8nListing).where(eq(n8nListing.developerId, developerId));
  await db.delete(n8nDerivationCounter).where(eq(n8nDerivationCounter.developerId, developerId));
  await db.delete(developerKey).where(eq(developerKey.developerId, developerId));
  await disconnectDb();
  await dns.close();
}
