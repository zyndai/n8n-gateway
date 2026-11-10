// Applies the Gateway migrations (same folder, same history table as drizzle-kit) and says what
// it did. `drizzle-kit migrate` can exit without printing anything behind a connection pooler,
// which leaves you guessing; this prints every step and exits non-zero on any failure.
//   DATABASE_URL=... npm run db:migrate
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

const folder = join(import.meta.dirname, '..', 'src', 'db', 'migrations');
const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
const target = new URL(url);
console.log(`[migrate] connecting to ${target.hostname}:${target.port || 5432}${target.pathname} as ${decodeURIComponent(target.username)}`);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [{ now }] = (await sql`select now()::text as now`) as unknown as [{ now: string }];
  console.log(`[migrate] connected (server time ${now})`);

  const applied = async (): Promise<number[]> => {
    const [{ exists }] = (await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`) as unknown as [{ exists: boolean }];
    if (!exists) return [];
    return (await sql`select created_at from drizzle.__drizzle_migrations`).map((r) => Number(r.created_at));
  };

  const before = new Set(await applied());
  const pending = journal.entries.filter((e) => !before.has(e.when));
  console.log(`[migrate] ${before.size} applied, ${pending.length} pending${pending.length ? `: ${pending.map((e) => e.tag).join(', ')}` : ''}`);

  await migrate(drizzle(sql), { migrationsFolder: folder, migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });

  const after = new Set(await applied());
  const missing = journal.entries.filter((e) => !after.has(e.when));
  if (missing.length) throw new Error(`still not recorded as applied: ${missing.map((e) => e.tag).join(', ')}`);
  for (const e of pending) console.log(`[migrate] applied ${e.tag}`);
  console.log(`[migrate] done: ${after.size}/${journal.entries.length} migrations applied${pending.length ? '' : ' (nothing to do)'}`);
} catch (e) {
  console.error(`[migrate] FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
