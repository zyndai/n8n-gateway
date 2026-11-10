// n8n_task persistence (LLD > N8nTask). Every status change is a compare-and-set on the current
// status, so a late `jobs/complete` can never overwrite a TIMEOUT or CANCELED, and two writers
// cannot both finish the same task.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { n8nTask } from '../db/schema.js';

export type TaskRow = typeof n8nTask.$inferSelect;
export type TaskStatus = TaskRow['status'];

export const OPEN_STATUSES: TaskStatus[] = ['PENDING', 'PROCESSING'];
export const isOpen = (s: TaskStatus): boolean => OPEN_STATUSES.includes(s);

export interface NewTask {
  developerId: string;
  listingId?: string | null;
  apiKeyId?: string | null;
  callerId?: string | null;
  direction: TaskRow['direction'];
  input: unknown;
  paymentUsd?: string | null;
  /** M2.20: the encrypted verified payment proof, kept until the payment is settled or released. */
  paymentProofEnc?: string | null;
}

export interface TaskPatch {
  output?: unknown;
  error?: string | null;
  paymentTxn?: string | null;
  paymentUsd?: string | null;
}

export interface TaskQuery {
  listingId?: string;
  direction?: TaskRow['direction'];
  limit: number;
  offset: number;
}

/** M6.2: one listing's inbound calls on one UTC day. `failed` = FAILED + TIMEOUT; cancelled calls count only in `calls`. */
export interface DailyStat {
  day: string; // YYYY-MM-DD, UTC
  listingId: string | null; // null once the listing was deleted
  calls: number;
  completed: number;
  failed: number;
  /** Settled payments of completed calls, "0.050000" form. */
  revenueUsd: string;
}

export interface TaskStoreLike {
  create(task: NewTask): Promise<TaskRow>;
  get(id: string): Promise<TaskRow | undefined>;
  /** Move a task to `to` only if it is currently in one of `from`; undefined if it was not. */
  transition(id: string, from: TaskStatus[], to: TaskStatus, patch?: TaskPatch): Promise<TaskRow | undefined>;
  /** M4.9: the developer's tasks, newest first. */
  listByDeveloper(developerId: string, query: TaskQuery): Promise<TaskRow[]>;
  /** M6.2: inbound calls per listing per day since `since`, oldest day first. */
  analytics(developerId: string, q: { since: Date; listingId?: string }): Promise<DailyStat[]>;
  /** Record payment details without changing status. */
  setPayment(id: string, patch: Pick<TaskPatch, 'paymentTxn' | 'paymentUsd'>): Promise<void>;
  /**
   * M2.20: take the right to settle a COMPLETED task's payment. Returns the encrypted proof, or
   * undefined when there is none, the task is not COMPLETED, or another process holds a lease newer than `leaseMs`.
   */
  claimProof(id: string, leaseMs: number, now?: Date): Promise<string | undefined>;
  /** M2.20: the payment settled: record the transaction, drop the proof and the lease. */
  finishPayment(id: string, paymentTxn: string): Promise<void>;
  /** M2.20: drop the proof (job did not succeed, or the authorization expired) and the lease. */
  clearProof(id: string): Promise<void>;
  /** M2.20: give the lease back after a failed settle, so the next sweep retries. */
  releaseLease(id: string): Promise<void>;
  /** M2.20: tasks that still hold a proof and have not changed since `before`, oldest first. */
  listUnsettled(before: Date, limit: number): Promise<TaskRow[]>;
}

export class TaskStore implements TaskStoreLike {
  constructor(private readonly db: Db) {}

  async create(task: NewTask) {
    const [row] = await this.db
      .insert(n8nTask)
      .values({
        developerId: task.developerId,
        listingId: task.listingId ?? null,
        apiKeyId: task.apiKeyId ?? null,
        callerId: task.callerId ?? null,
        direction: task.direction,
        input: task.input,
        paymentUsd: task.paymentUsd ?? null,
        paymentProofEnc: task.paymentProofEnc ?? null,
      })
      .returning();
    if (!row) throw new Error('task insert returned no row');
    return row;
  }

  async get(id: string) {
    const [row] = await this.db.select().from(n8nTask).where(eq(n8nTask.id, id)).limit(1);
    return row;
  }

  async transition(id: string, from: TaskStatus[], to: TaskStatus, patch: TaskPatch = {}) {
    const [row] = await this.db
      .update(n8nTask)
      .set({ status: to, ...patch })
      .where(and(eq(n8nTask.id, id), inArray(n8nTask.status, from)))
      .returning();
    return row;
  }

  async listByDeveloper(developerId: string, q: TaskQuery) {
    return this.db
      .select()
      .from(n8nTask)
      .where(
        and(
          eq(n8nTask.developerId, developerId),
          q.listingId ? eq(n8nTask.listingId, q.listingId) : undefined,
          q.direction ? eq(n8nTask.direction, q.direction) : undefined,
        ),
      )
      .orderBy(desc(n8nTask.createdAt))
      .limit(q.limit)
      .offset(q.offset);
  }

  async analytics(developerId: string, q: { since: Date; listingId?: string }) {
    const day = sql<string>`to_char(date_trunc('day', ${n8nTask.createdAt}), 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({
        day,
        listingId: n8nTask.listingId,
        calls: sql<number>`count(*)::int`,
        completed: sql<number>`(count(*) filter (where ${n8nTask.status} = 'COMPLETED'))::int`,
        failed: sql<number>`(count(*) filter (where ${n8nTask.status} in ('FAILED', 'TIMEOUT')))::int`,
        revenueUsd: sql<string>`coalesce(sum(${n8nTask.paymentUsd}) filter (where ${n8nTask.status} = 'COMPLETED' and ${n8nTask.paymentTxn} is not null), 0)::numeric(18,6)::text`,
      })
      .from(n8nTask)
      .where(
        and(
          eq(n8nTask.developerId, developerId),
          eq(n8nTask.direction, 'INBOUND'),
          gte(n8nTask.createdAt, q.since),
          q.listingId ? eq(n8nTask.listingId, q.listingId) : undefined,
        ),
      )
      .groupBy(day, n8nTask.listingId)
      .orderBy(day);
    return rows;
  }

  async setPayment(id: string, patch: Pick<TaskPatch, 'paymentTxn' | 'paymentUsd'>) {
    await this.db.update(n8nTask).set(patch).where(eq(n8nTask.id, id));
  }

  async claimProof(id: string, leaseMs: number, now: Date = new Date()) {
    const stale = new Date(now.getTime() - leaseMs);
    const [row] = await this.db
      .update(n8nTask)
      .set({ paymentLeaseAt: now })
      .where(
        and(
          eq(n8nTask.id, id),
          eq(n8nTask.status, 'COMPLETED'),
          isNotNull(n8nTask.paymentProofEnc),
          or(isNull(n8nTask.paymentLeaseAt), lt(n8nTask.paymentLeaseAt, stale)),
        ),
      )
      .returning({ proof: n8nTask.paymentProofEnc });
    return row?.proof ?? undefined;
  }

  async finishPayment(id: string, paymentTxn: string) {
    await this.db.update(n8nTask).set({ paymentTxn, paymentProofEnc: null, paymentLeaseAt: null }).where(eq(n8nTask.id, id));
  }

  async clearProof(id: string) {
    await this.db.update(n8nTask).set({ paymentProofEnc: null, paymentLeaseAt: null }).where(eq(n8nTask.id, id));
  }

  async releaseLease(id: string) {
    await this.db.update(n8nTask).set({ paymentLeaseAt: null }).where(eq(n8nTask.id, id));
  }

  async listUnsettled(before: Date, limit: number) {
    return this.db
      .select()
      .from(n8nTask)
      .where(and(isNotNull(n8nTask.paymentProofEnc), lt(n8nTask.updatedAt, before)))
      .orderBy(n8nTask.updatedAt)
      .limit(limit);
  }
}
