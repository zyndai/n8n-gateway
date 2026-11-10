// G12/G21: the Gateway and the dashboard share one database but never migrate each other's tables.
// Everything a Gateway migration creates, alters or drops must be an `n8n_*` table; the dashboard's
// tables may only appear as the target of a foreign key.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'src', 'db', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const ident = String.raw`(?:"public"\.)?"?(\w+)"?`;
// One regex per statement shape; capture 1 is the object being created, altered or dropped.
const TARGETS = [
  new RegExp(String.raw`^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?|DROP TABLE(?: IF EXISTS)?|TRUNCATE(?: TABLE)?)\s+${ident}`, 'i'),
  new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX\s[^]*?\sON\s+${ident}`, 'i'),
  new RegExp(String.raw`^(?:INSERT INTO|DELETE FROM|UPDATE)\s+${ident}`, 'i'),
  // Enum types are Gateway-owned too, and are named N8n*.
  new RegExp(String.raw`^(?:CREATE|ALTER|DROP) TYPE\s+${ident}`, 'i'),
];

describe('Gateway migrations only touch Gateway tables', () => {
  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const f of files) {
    it(f, () => {
      const statements = readFileSync(join(dir, f), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const st of statements) {
        const m = TARGETS.map((re) => re.exec(st)).find(Boolean);
        // DROP INDEX / DROP CONSTRAINT style statements are matched through their table; anything
        // unrecognised must be looked at by a person.
        expect(m, `${f}: unrecognised statement: ${st.slice(0, 80)}`).toBeTruthy();
        expect(m![1], `${f} writes to ${m![1]}, which is not a Gateway object`).toMatch(/^(?:n8n_|N8n)/);
      }
    });
  }
});
