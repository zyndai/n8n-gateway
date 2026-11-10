// LLD > A2AHandler (M2.9-M2.12). Inbound paid calls, HLD flow 4:
//   listing ACTIVE -> auth (middleware) -> x402 verify -> PENDING task -> webhook -> wait -> settle -> A2A result
//
// Decisions beyond the LLD text:
//  - The payment is verified up front but settled only after the job COMPLETED, so a failed,
//    timed-out or cancelled job is never charged (G17).
//  - If the webhook's own response carries a top-level `output`, the job is finished right there
//    (the synchronous `responseMode = lastNode` path), otherwise the Gateway waits for `jobs/complete` (G2).
//  - tasks/get and tasks/cancel are authorised by holding the task id plus matching the entity (G6).
import { ApiError } from '../errors.js';
import type { ListingRow } from './ListingStore.js';
import type { Ed25519Keypair } from './IdentityService.js';
import type { PaymentProcessor, HeaderBag, PaymentRequirements, VerifiedPayment } from './PaymentProcessor.js';
import { effectivePriceUsd, formatUsd } from './money.js';
import { isOpen, type TaskRow, type TaskStoreLike } from './TaskStore.js';
import { TaskWaiter } from './TaskWaiter.js';
import { ZYND_AUTH_KEY, type A2AMessage, type VerifiedCaller } from './zyndAuth.js';
import type { ForwardPayload, ForwardResult } from './WebhookForwarder.js';

export const TASK_TIMEOUT_MS = 300_000;
export const POLL_INTERVAL_MS = 2_000;

/** 402 that also tells the caller what to pay (`PAYMENT-REQUIRED` response header). */
export class PaymentRequiredError extends ApiError {
  constructor(
    message: string,
    readonly paymentRequiredHeader: string,
    details?: unknown,
  ) {
    super('PAYMENT_FAILED', message, details);
    this.name = 'PaymentRequiredError';
  }
}

export interface A2AHandlerDeps {
  listings: {
    getByEntityId(entityId: string): Promise<ListingRow | undefined>;
    getById(listingId: string): Promise<ListingRow | undefined>;
    webhookTarget(listing: ListingRow): { url: string; secret: string } | undefined;
  };
  tasks: TaskStoreLike;
  payments: Pick<PaymentProcessor, 'evmAddress' | 'requirementsFor' | 'paymentRequiredHeader' | 'verifyX402' | 'settle' | 'release'>;
  identity: { getListingKeypair(ref: { listingId: string; developerId: string; derivedKeyIndex: number }): Promise<Ed25519Keypair> };
  forwarder: { forward(url: string, secret: string, payload: ForwardPayload): Promise<ForwardResult> };
  waiter?: TaskWaiter;
  /** Default USD price of one inbound call, used by listings without their own price. Unset = free (x402 headers are ignored). */
  inboundPriceUsd?: string;
  publicUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface SendResult {
  task: A2ATask;
  /** Base64 `PAYMENT-RESPONSE` header value when a payment was settled. */
  paymentResponse?: string;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: string; timestamp: string; message?: unknown };
  artifacts?: { artifactId: string; name: string; parts: unknown[] }[];
  metadata?: Record<string, unknown>;
}

export type JobResult = { output: unknown } | { error: string };

/** The workflow-facing view of a payload: single data part, else joined text, else the raw parts. */
export function deriveInput(message: A2AMessage): unknown {
  const parts = Array.isArray(message.parts) ? (message.parts as { kind?: string; text?: string; data?: unknown }[]) : [];
  if (parts.length === 1 && parts[0]?.kind === 'data') return parts[0].data;
  if (parts.length > 0 && parts.every((p) => p.kind === 'text' && typeof p.text === 'string')) return parts.map((p) => p.text).join('\n');
  return parts;
}

function stripAuth(message: A2AMessage): A2AMessage {
  const { [ZYND_AUTH_KEY]: _auth, ...metadata } = message.metadata ?? {};
  return { ...message, metadata };
}

const STATE: Record<TaskRow['status'], string> = {
  PENDING: 'submitted',
  PROCESSING: 'working',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'failed',
  CANCELED: 'canceled',
};

export function toA2ATask(row: TaskRow): A2ATask {
  const status: A2ATask['status'] = { state: STATE[row.status], timestamp: row.updatedAt.toISOString() };
  const reason = row.status === 'TIMEOUT' ? 'Task timed out' : row.error;
  if (reason && (row.status === 'FAILED' || row.status === 'TIMEOUT')) {
    status.message = { kind: 'message', messageId: `${row.id}-status`, role: 'agent', parts: [{ kind: 'text', text: reason }] };
  }
  const task: A2ATask = { kind: 'task', id: row.id, contextId: row.id, status };
  if (row.status === 'COMPLETED' && row.output !== null && row.output !== undefined) {
    const out = row.output;
    task.artifacts = [{ artifactId: 'output', name: 'output', parts: [typeof out === 'string' ? { kind: 'text', text: out } : { kind: 'data', data: out }] }];
  }
  if (row.paymentTxn) task.metadata = { paymentTxn: row.paymentTxn };
  return task;
}

export class A2AHandler {
  readonly waiter: TaskWaiter;
  private readonly payTo = new Map<string, string>();

  constructor(private readonly deps: A2AHandlerDeps) {
    this.waiter = deps.waiter ?? new TaskWaiter();
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? TASK_TIMEOUT_MS;
  }

  /** M2.9: the seven steps of `tasks/send`. `caller` was verified by the a2aAuth middleware (step 2). */
  async tasksSend(entityId: string, message: A2AMessage, caller: VerifiedCaller, headers: HeaderBag): Promise<SendResult> {
    // 1. Listing must exist, be ACTIVE and have somewhere to send the job.
    const listing = await this.deps.listings.getByEntityId(entityId);
    if (!listing) throw new ApiError('NOT_FOUND', 'Unknown agent');
    const target = listing.status === 'ACTIVE' ? this.deps.listings.webhookTarget(listing) : undefined;
    if (!target) throw new ApiError('LISTING_INACTIVE', listing.status === 'ACTIVE' ? 'Listing has no webhook bound' : undefined);

    // 3. Payment.
    const verified = await this.verifyPayment(listing, headers);

    // 4. Task.
    const clean = stripAuth(message);
    const task = await this.deps.tasks.create({
      developerId: listing.developerId,
      listingId: listing.id,
      callerId: caller.entityId,
      direction: 'INBOUND',
      input: clean,
      paymentUsd: verified ? formatUsd(verified.amountMicroUsd) : null,
    });

    // 5. Forward to n8n.
    try {
      const res = await this.deps.forwarder.forward(target.url, target.secret, {
        jobId: task.id,
        listingId: listing.id,
        entityId,
        caller: caller.entityId,
        input: deriveInput(clean),
        message: clean,
        createdAt: task.createdAt.toISOString(),
      });
      await this.deps.tasks.transition(task.id, ['PENDING'], 'PROCESSING');
      const body = res.body;
      if (body && typeof body === 'object' && !Array.isArray(body) && 'output' in body) {
        await this.finish(task.id, { output: (body as { output: unknown }).output });
      }
    } catch (err) {
      await this.deps.tasks.transition(task.id, ['PENDING', 'PROCESSING'], 'FAILED', { error: err instanceof ApiError ? err.message : 'Could not reach the workflow' });
      if (verified) this.deps.payments.release(verified);
      throw err;
    }

    // 6. Wait for the result.
    const done = await this.waitFor(task.id);

    // 7. Settle (only a COMPLETED job is charged) and answer.
    let paymentResponse: string | undefined;
    if (verified) {
      if (done.status === 'COMPLETED') {
        const settled = await this.deps.payments.settle(verified);
        await this.deps.tasks.setPayment(task.id, { paymentTxn: settled.transaction });
        done.paymentTxn = settled.transaction;
        paymentResponse = Buffer.from(JSON.stringify({ success: true, transaction: settled.transaction, payer: settled.payer, network: verified.requirements.network }), 'utf8').toString('base64');
      } else {
        this.deps.payments.release(verified);
      }
    }
    if (done.status === 'TIMEOUT') throw new ApiError('TASK_TIMEOUT');
    return { task: toA2ATask(done), ...(paymentResponse ? { paymentResponse } : {}) };
  }

  /** M2.10: current state of a task, if it belongs to this entity. */
  async tasksGet(entityId: string, taskId: string): Promise<A2ATask> {
    return toA2ATask(await this.ownedTask(entityId, taskId));
  }

  /**
   * M2.10 / G6: cancel an open task. The Gateway cannot stop a running n8n execution (it has no
   * access to the n8n instance), so this only ends the A2A task: the caller stops waiting, the
   * payment is released, and a later `jobs/complete` for it is refused.
   */
  async tasksCancel(entityId: string, taskId: string): Promise<A2ATask> {
    const row = await this.ownedTask(entityId, taskId);
    const canceled = await this.deps.tasks.transition(row.id, ['PENDING', 'PROCESSING'], 'CANCELED', { error: 'Canceled by caller' });
    if (!canceled) throw new ApiError('CONFLICT', `Task is already ${STATE[row.status]} and cannot be canceled`);
    this.waiter.notify(row.id);
    return toA2ATask(canceled);
  }

  /** M2.11: the workflow reports its result (`POST /n8n/v1/jobs/:id/complete`). */
  async completeJob(developerId: string, taskId: string, result: JobResult): Promise<A2ATask> {
    const row = await this.deps.tasks.get(taskId);
    // 404 for someone else's task, so ids cannot be probed.
    if (!row || row.developerId !== developerId || row.direction !== 'INBOUND') throw new ApiError('NOT_FOUND', 'Job not found');
    const done = await this.finish(taskId, result);
    if (!done) throw new ApiError('CONFLICT', `Job is already ${STATE[row.status]}`);
    return toA2ATask(done);
  }

  // --- internals -----------------------------------------------------------------------------

  private async finish(taskId: string, result: JobResult): Promise<TaskRow | undefined> {
    const row =
      'error' in result
        ? await this.deps.tasks.transition(taskId, ['PENDING', 'PROCESSING'], 'FAILED', { error: result.error })
        : await this.deps.tasks.transition(taskId, ['PENDING', 'PROCESSING'], 'COMPLETED', { output: result.output ?? null });
    if (row) this.waiter.notify(taskId);
    return row;
  }

  /** Poll every `pollIntervalMs` (woken early by the waiter) until the task is terminal or 300 s pass. */
  private async waitFor(taskId: string): Promise<TaskRow> {
    const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const row = await this.deps.tasks.get(taskId);
      if (!row) throw new ApiError('INTERNAL', 'Task disappeared');
      if (!isOpen(row.status)) return row;
      const left = deadline - Date.now();
      if (left <= 0) {
        const timedOut = await this.deps.tasks.transition(taskId, ['PENDING', 'PROCESSING'], 'TIMEOUT', { error: 'Task timed out' });
        // Lost the race to a completion that landed just now: honour it.
        return timedOut ?? ((await this.deps.tasks.get(taskId)) as TaskRow);
      }
      await this.waiter.wait(taskId, Math.min(interval, left));
    }
  }

  private async verifyPayment(listing: ListingRow, headers: HeaderBag): Promise<VerifiedPayment | undefined> {
    const price = effectivePriceUsd(listing.priceUsd, this.deps.inboundPriceUsd);
    if (!price) return undefined;
    const requirements = await this.requirementsFor(listing, price);
    const header = (error?: string): string => this.deps.payments.paymentRequiredHeader(requirements, `${this.deps.publicUrl}/a/${listing.entityId}`, error);
    try {
      return await this.deps.payments.verifyX402(headers, requirements);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PAYMENT_FAILED') throw new PaymentRequiredError(err.message, header(err.message), err.details);
      throw err;
    }
  }

  private async requirementsFor(listing: ListingRow, priceUsd: string): Promise<PaymentRequirements> {
    let address = this.payTo.get(listing.id);
    if (!address) {
      const kp = await this.deps.identity.getListingKeypair({ listingId: listing.id, developerId: listing.developerId, derivedKeyIndex: listing.derivedKeyIndex });
      address = this.deps.payments.evmAddress(kp.privateKey);
      this.payTo.set(listing.id, address);
    }
    return this.deps.payments.requirementsFor(address, priceUsd);
  }

  private async ownedTask(entityId: string, taskId: string): Promise<TaskRow> {
    const row = await this.deps.tasks.get(taskId);
    const listing = row?.listingId ? await this.deps.listings.getById(row.listingId) : undefined;
    if (!row || row.direction !== 'INBOUND' || !listing || listing.entityId !== entityId) throw new ApiError('NOT_FOUND', 'Task not found');
    return row;
  }
}
