// In-memory twins of ApiKeyStore / TaskStore / NonceStore with the same atomic semantics
// (single-threaded JS makes each method one atomic step, like the single SQL statement it mirrors).
import { randomUUID } from 'node:crypto';
import type { ApiKeyRow, ApiKeyStoreLike, NewApiKey } from '../../src/services/ApiKeyStore.js';
import { hashApiKey } from '../../src/middleware/apiKeyAuth.js';
import { formatUsd, parseUsd } from '../../src/services/money.js';
import type { NonceStoreLike } from '../../src/services/NonceStore.js';
import type { NewTask, TaskPatch, TaskQuery, TaskRow, TaskStatus, TaskStoreLike } from '../../src/services/TaskStore.js';

export class MemoryApiKeys implements ApiKeyStoreLike {
  rows = new Map<string, ApiKeyRow>();
  touches = 0;

  add(plaintext: string, fields: Partial<ApiKeyRow> & { developerId: string }): ApiKeyRow {
    const now = new Date();
    const row: ApiKeyRow = {
      id: randomUUID(),
      name: 'test',
      keyHash: hashApiKey(plaintext),
      keyPrefix: plaintext.slice(0, 8),
      permissions: ['search', 'call', 'complete'],
      spendCapUsd: null,
      spentUsd: '0.000000',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async findByHash(keyHash: string) {
    return [...this.rows.values()].find((r) => r.keyHash === keyHash);
  }
  async create(key: NewApiKey) {
    const now = new Date();
    const row: ApiKeyRow = { id: randomUUID(), spentUsd: '0.000000', lastUsedAt: null, revokedAt: null, createdAt: now, updatedAt: now, ...key };
    this.rows.set(row.id, row);
    return row;
  }
  async listByDeveloper(developerId: string) {
    return [...this.rows.values()].filter((r) => r.developerId === developerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async revoke(developerId: string, id: string, at: Date) {
    const r = this.rows.get(id);
    if (!r || r.developerId !== developerId) return undefined;
    const next = { ...r, revokedAt: r.revokedAt ?? at };
    this.rows.set(id, next);
    return next;
  }
  async touch(id: string, at: Date) {
    this.touches++;
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, lastUsedAt: at });
  }
  async reserveSpend(id: string, micro: bigint) {
    const r = this.rows.get(id);
    if (!r) return false;
    const next = parseUsd(r.spentUsd) + micro;
    if (r.spendCapUsd !== null && next > parseUsd(r.spendCapUsd)) return false;
    this.rows.set(id, { ...r, spentUsd: formatUsd(next) });
    return true;
  }
  async refundSpend(id: string, micro: bigint) {
    const r = this.rows.get(id);
    if (!r) return;
    const cur = parseUsd(r.spentUsd);
    this.rows.set(id, { ...r, spentUsd: formatUsd(cur > micro ? cur - micro : 0n) });
  }
  spent(id: string): bigint {
    return parseUsd((this.rows.get(id) as ApiKeyRow).spentUsd);
  }
}

export class MemoryTasks implements TaskStoreLike {
  rows = new Map<string, TaskRow>();

  async create(t: NewTask) {
    const now = new Date();
    const row: TaskRow = {
      id: randomUUID(),
      developerId: t.developerId,
      listingId: t.listingId ?? null,
      apiKeyId: t.apiKeyId ?? null,
      callerId: t.callerId ?? null,
      direction: t.direction,
      input: t.input,
      output: null,
      status: 'PENDING',
      paymentTxn: null,
      paymentUsd: t.paymentUsd ?? null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async get(id: string) {
    return this.rows.get(id);
  }
  async transition(id: string, from: TaskStatus[], to: TaskStatus, patch: TaskPatch = {}) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return undefined;
    const next = { ...r, ...patch, status: to, updatedAt: new Date() } as TaskRow;
    this.rows.set(id, next);
    return next;
  }
  async listByDeveloper(developerId: string, q: TaskQuery) {
    return [...this.rows.values()]
      .filter((r) => r.developerId === developerId && (!q.listingId || r.listingId === q.listingId) && (!q.direction || r.direction === q.direction))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(q.offset, q.offset + q.limit);
  }
  async setPayment(id: string, patch: Pick<TaskPatch, 'paymentTxn' | 'paymentUsd'>) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...patch } as TaskRow);
  }
}

export class MemoryNonces implements NonceStoreLike {
  seen = new Map<string, Date>();
  async claim(key: string, expiresAt: Date) {
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
  async purgeExpired(now = new Date()) {
    let n = 0;
    for (const [k, exp] of this.seen) {
      if (exp < now) {
        this.seen.delete(k);
        n++;
      }
    }
    return n;
  }
}
