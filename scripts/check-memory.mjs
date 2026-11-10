// M0.19: memory guard for CI. Boots the BUNDLED Gateway exactly as `npm start` does, hits /health
// repeatedly, and fails if RSS passes the budget, so a dependency that bloats the process is
// caught in the PR that adds it.
//
//   npm run build && npm run check:memory
//
// Two runs: bare (no database) and, when DATABASE_URL is set, with the full service graph and a
// Postgres pool (0 listings). The with-database budget is the PRD's 95 / 110 MB. The bare budget
// is the M0.17 figure (80 MB idle) plus the growth M2 added (bare idle is about 82 MB). M2.18
// found no single cause for that growth, so 85 / 100 stays.
// The 200-socket measurement lives in `npm run measure:memory` (M1.14).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

const REQUESTS = Number(process.env.REQUESTS ?? 3000);
const CONCURRENCY = 20;
const BARE = { idle: Number(process.env.BARE_IDLE_MB ?? 85), peak: Number(process.env.BARE_PEAK_MB ?? 100) };
const WITH_DB = { idle: Number(process.env.DB_IDLE_MB ?? 95), peak: Number(process.env.DB_PEAK_MB ?? 110) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;

async function run(label, port, budget, extraEnv) {
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=96', '--max-semi-space-size=2', '--optimize-for-size', 'dist/index.mjs'],
    { env: { ...process.env, DATABASE_URL: '', ...extraEnv, PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  let exited = false;
  child.on('exit', () => (exited = true));
  try {
    const url = `http://127.0.0.1:${port}/health`;
    for (let i = 0; ; i++) {
      if (exited) throw new Error('Gateway exited during startup');
      if (i > 100) throw new Error('Gateway did not answer /health in 10 s');
      if (await fetch(url).then((r) => r.ok, () => false)) break;
      await sleep(100);
    }
    await sleep(500);
    const idle = rssMb(child.pid);

    let next = 0;
    let peak = idle;
    const sampler = setInterval(() => (peak = Math.max(peak, rssMb(child.pid))), 100);
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next++ < REQUESTS) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`/health answered ${res.status}`);
          await res.arrayBuffer();
        }
      }),
    );
    clearInterval(sampler);
    await sleep(500);
    const after = rssMb(child.pid);
    peak = Math.max(peak, after);

    const ok = idle <= budget.idle && peak <= budget.peak;
    console.log(`${label}: idle ${idle.toFixed(1)} MB, peak ${peak.toFixed(1)} MB after ${REQUESTS} requests (budget idle <= ${budget.idle}, peak <= ${budget.peak}) ${ok ? 'ok' : 'OVER BUDGET'}`);
    return ok;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (exited ? r() : child.once('exit', r)));
  }
}

const results = [await run('bare (/health only)', 18090, BARE, {})];
if (process.env.DATABASE_URL) {
  results.push(
    await run('with database', 18091, WITH_DB, {
      DATABASE_URL: process.env.DATABASE_URL,
      PKI_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SESSION_JWT_SECRET: randomBytes(32).toString('hex'),
    }),
  );
} else {
  console.log('with database: skipped (DATABASE_URL not set)');
}
if (results.includes(false)) process.exit(1);
