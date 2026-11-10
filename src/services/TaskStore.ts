// n8n_task persistence (LLD > N8nTask). Every status change is a compare-and-set on the current
// status, so a late `jobs/complete` can never overwrite a TIMEOUT or CANCELED, and two writers
// cannot both finish the same task.
import { and, eq, inArray } from 'drizzle-orm';
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
}

export interface TaskPatch {
  output?: unknown;
  error?: string | null;
  paymentTxn?: string | null;
  paymentUsd?: string | null;
}

export interface TaskStoreLike {
  create(task: NewTask): Promise<TaskRow>;
  get(id: string): Promise<TaskRow | undefined>;
  /** Move a task to `to` only if it is currently in one of `from`; undefined if it was not. */
  transition(id: string, from: TaskStatus[], to: TaskStatus, patch?: TaskPatch): Promise<TaskRow | undefined>;
  /** Record payment details without changing status. */
  setPayment(id: string, patch: Pick<TaskPatch, 'paymentTxn' | 'paymentUsd'>): Promise<void>;
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

  async setPayment(id: string, patch: Pick<TaskPatch, 'paymentTxn' | 'paymentUsd'>) {
    await this.db.update(n8nTask).set(patch).where(eq(n8nTask.id, id));
  }
}
