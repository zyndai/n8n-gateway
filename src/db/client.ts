import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

let sql: ReturnType<typeof postgres> | undefined;
let db: Db | undefined;

/**
 * Lazy singleton so importing the app (tests, /health) never opens a connection.
 * Small pool on purpose: the Gateway is sized for a very low memory footprint, and its
 * queries are short. `prepare: false` avoids per-connection prepared-statement caches and
 * keeps this safe behind PgBouncer-style poolers.
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    sql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 4), prepare: false, idle_timeout: 30 });
    db = drizzle(sql, { schema });
  }
  return db;
}

export async function disconnectDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = undefined;
    db = undefined;
  }
}
