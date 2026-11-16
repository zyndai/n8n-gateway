// S4.2: no raw error text or technical word reaches the screen. Everything a person reads lives in lib/copy.ts (and
// the few plain sentences the server sends), so these checks read those, and the UI's source, instead of clicking.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentErrorCode } from '@/lib/agents/service';
import { errorBody } from '@/lib/api-guard';
import { plainBuilderError } from '@/lib/builder/loop';
import { apiMessage, copy } from '@/lib/copy';
import { GatewayError } from '@/lib/gateway/client';
import { McpError } from '@/lib/n8n/mcp';
import { OpenAIError, type OpenAIErrorKind } from '@/lib/openai';

/** Words from the plan's "Never shown" table, plus the other technical words a person has no use for. */
const BANNED = /\b(listings?|entity|entities|zns|workflows?|nodes?|webhooks?|n8n|x402|api keys?|wallets?|ausd|usdc|tx hash|heartbeat|inactive|mcp|json|gateway|credentials?|tokens?|stack|exception|undefined|null)\b/i;

/** Every string in `copy`, calling the functions in it with sample arguments. */
function strings(value: unknown, path = 'copy'): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') return strings((value as (...a: string[]) => unknown)('$1.00', '$2.00', '3'), `${path}()`);
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

describe('the words a person reads', () => {
  const all = strings(copy);
  it('are many (the walk found them)', () => expect(all.length).toBeGreaterThan(100));
  it('contain no technical vocabulary', () => {
    const bad = all.filter(([, text]) => BANNED.test(text)).map(([path, text]) => `${path}: ${text}`);
    expect(bad).toEqual([]);
  });
  it('never show a bare code, a stack or a path', () => {
    for (const [path, text] of all) {
      expect(text, path).not.toMatch(/\bat \S+\.(ts|js)\b|ECONN|ETIMEDOUT|HTTP \d{3}|\b[45]\d\d\b error|Error:|\/opt\//);
    }
  });
});

describe('every error code has plain words', () => {
  const codes: AgentErrorCode[] = ['not-found', 'limit', 'bad-input', 'no-workflow', 'not-ready', 'not-live', 'registration', 'unavailable'];
  const plain = new Set<string>(Object.values(copy.errors));

  it('each code Studio\'s API can send maps to one of the written messages', () => {
    for (const code of [...codes, 'signed-out', 'preview', 'not-configured', 'forbidden', undefined, 'something-new']) expect(plain.has(apiMessage(code)), String(code)).toBe(true);
  });
  it('a service being down says so, instead of the generic line', () => {
    expect(apiMessage('unavailable')).toBe(copy.errors.unavailable);
    expect(apiMessage('unavailable')).not.toBe(copy.errors.generic);
  });
  it('a failed run says why in plain words: out of credit, a helper that did not answer, too long', () => {
    expect(apiMessage(undefined, 'credit')).toBe(copy.errors.outOfCredit);
    expect(apiMessage(undefined, 'helper')).toBe(copy.errors.helperFailed);
    expect(apiMessage(undefined, 'timeout')).toBe(copy.errors.tookTooLong);
    expect(apiMessage(undefined, 'other')).toBe(copy.errors.generic);
  });
  it('out of credit gives a next step that exists today (there are no top-ups yet)', () => {
    expect(copy.errors.outOfCredit).toMatch(/ask the Studio team/i);
    expect(copy.errors.outOfCredit).not.toMatch(/add credit and/i);
  });
  it('nothing a server says is passed through: text that is not a known code reads as the generic line', () => {
    for (const raw of ['ECONNREFUSED 10.0.0.4:5678', 'Error: Workflow 41 has no published version', 'Payment failed: insufficient balance']) expect(apiMessage(raw)).toBe(copy.errors.generic);
  });
  it('the API sends codes, never messages, for every kind of failure', () => {
    for (const err of [new GatewayError('Listing 742b9b1f not found at https://internal:3000', 500, 'X'), new McpError('n8n token rejected: Bearer abc'), new Error('boom at /opt/app/x.ts:1')]) {
      const { body } = errorBody(err);
      expect(Object.keys(body)).toEqual(['error']);
      expect(body.error).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('what the builder says when something fails', () => {
  const kinds: OpenAIErrorKind[] = ['auth', 'rate', 'model', 'unreachable', 'other'];
  it('is plain, whatever OpenAI answered, and never carries its text', () => {
    for (const kind of kinds) {
      const text = plainBuilderError(new OpenAIError('Incorrect API key provided: sk-live-123 for org-abc', kind, 401));
      expect(text, kind).not.toMatch(BANNED);
      expect(text).not.toMatch(/sk-live|org-abc/);
    }
    expect(plainBuilderError(new Error('TypeError: x is not a function'))).not.toMatch(/TypeError/);
  });
});

describe('the screens', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'node_modules' || name === '.next' || name === 'ui') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx$/.test(name)) files.push(full);
    }
  };
  walk(join(__dirname, '..', 'components'));
  walk(join(__dirname, '..', 'app'));

  it('read the screens (the walk found them)', () => expect(files.length).toBeGreaterThan(15));

  it('never put an error\'s own message on the page', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\b(err|error|e)\.(message|stack)\b|String\(err\)/.test(line) && !/PlainError|case 'error'|e\.message \}\)|say\(\{ role: 'agent', text: e\.message/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('use the error page\'s plain words, not Next\'s own', () => {
    expect(files.some((f) => f.endsWith(join('app', '(app)', 'error.tsx')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('app', 'global-error.tsx')))).toBe(true);
  });
});
