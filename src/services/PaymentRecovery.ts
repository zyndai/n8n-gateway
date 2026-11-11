// M2.20 (G17): inbound payments are verified up front and settled after the job COMPLETED, so a
// Gateway crash in between leaves a verified, unsettled payment. The verified proof is therefore
// sealed (AES-256-GCM, same key as the other secrets) onto the task row, and `PaymentRecovery`
// sweeps for tasks that still hold one:
//   COMPLETED                              -> settle it, exactly once (a lease row-claim picks the winner)
//   FAILED / TIMEOUT / CANCELED            -> release it (nobody is charged)
//   still open, older than the task cap    -> the request that was waiting died with the process: TIMEOUT, release
//   authorization past its `validBefore`   -> release it, the facilitator would reject it anyway
// A COMPLETED task is only touched after a grace period, so a live request that is about to settle
// itself is never raced; the lease covers the remaining overlap.
import { ApiError } from '../errors.js';
import { SETTLE_LEASE_MS, TASK_TIMEOUT_MS } from './A2AHandler.js';
import type { PaymentProcessor, VerifiedPayment } from './PaymentProcessor.js';
import type { TaskRow, TaskStoreLike } from './TaskStore.js';
import { decryptSecret, encryptSecret } from './keyVault.js';
import { logPayment, usd, type PaymentLogger } from './paymentLog.js';

/** Seals a `VerifiedPayment` for storage on the task row. */
export class PaymentProofVault {
  constructor(private readonly masterKey: Buffer) {}

  seal(v: VerifiedPayment): string {
    return encryptSecret(JSON.stringify({ v: 1, ...v, amountMicroUsd: v.amountMicroUsd.toString() }), this.masterKey);
  }

  open(sealed: string): VerifiedPayment {
    const o = JSON.parse(decryptSecret(sealed, this.masterKey)) as { v?: number; payer: string; amountMicroUsd: string; paymentPayload: VerifiedPayment['paymentPayload']; requirements: VerifiedPayment['requirements'] };
    if (o.v !== 1) throw new Error('unknown payment proof version');
    return { payer: o.payer, amountMicroUsd: BigInt(o.amountMicroUsd), paymentPayload: o.paymentPayload, requirements: o.requirements };
  }
}

/** A COMPLETED task is left to its own request this long before the sweep settles it. */
export const SETTLE_GRACE_MS = 30_000;

export interface RecoveryResult {
  settled: number;
  released: number;
  failed: number;
}

export interface PaymentRecoveryDeps {
  tasks: Pick<TaskStoreLike, 'listUnsettled' | 'claimProof' | 'finishPayment' | 'clearProof' | 'releaseLease' | 'transition'>;
  payments: Pick<PaymentProcessor, 'settle' | 'release'>;
  vault: PaymentProofVault;
  now?: () => number;
  graceMs?: number;
  leaseMs?: number;
  taskTimeoutMs?: number;
  batch?: number;
  /** Payment log lines (one per event). Defaults to `console`. */
  log?: PaymentLogger;
}

export class PaymentRecovery {
  private running = false;
  private readonly log: PaymentLogger;

  constructor(private readonly deps: PaymentRecoveryDeps) {
    this.log = deps.log ?? console;
  }

  /** One pass. Safe to call from several processes and from a timer; overlapping calls in one process are skipped. */
  async run(): Promise<RecoveryResult> {
    const out: RecoveryResult = { settled: 0, released: 0, failed: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const rows = await this.deps.tasks.listUnsettled(new Date(now - (this.deps.graceMs ?? SETTLE_GRACE_MS)), this.deps.batch ?? 100);
      for (const row of rows) {
        try {
          const r = await this.recover(row, now);
          if (r) out[r]++;
        } catch (err) {
          out.failed++;
          // settle() already logged why the facilitator said no; this line says which task the sweep gave up on.
          logPayment(this.log, 'error', 'payment recovery failed', {
            job: row.id,
            listing: row.listingId,
            cause: err instanceof ApiError ? err.code : undefined,
            reason: err instanceof ApiError ? err.message : (err as Error)?.message,
          });
        }
      }
      if (out.settled || out.released || out.failed) {
        logPayment(this.log, out.failed ? 'warn' : 'info', 'payment recovery sweep', { settled: out.settled, released: out.released, failed: out.failed });
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  private async recover(row: TaskRow, now: number): Promise<'settled' | 'released' | undefined> {
    const { tasks } = this.deps;
    if (row.status === 'PENDING' || row.status === 'PROCESSING') {
      // Younger than the task cap: the request that opened it may still be alive, or n8n may yet complete it.
      if (now - row.createdAt.getTime() <= (this.deps.taskTimeoutMs ?? TASK_TIMEOUT_MS) + 60_000) return undefined;
      await tasks.transition(row.id, ['PENDING', 'PROCESSING'], 'TIMEOUT', { error: 'Task timed out' });
      await tasks.clearProof(row.id);
      return 'released';
    }
    if (row.status !== 'COMPLETED') {
      await tasks.clearProof(row.id);
      return 'released';
    }
    const sealed = await tasks.claimProof(row.id, this.deps.leaseMs ?? SETTLE_LEASE_MS, new Date(now));
    if (!sealed) return undefined; // settled, or another process holds the lease
    let verified: VerifiedPayment;
    try {
      verified = this.deps.vault.open(sealed);
    } catch (err) {
      await tasks.clearProof(row.id); // unreadable (key changed): retrying cannot help
      throw err;
    }
    const validBefore = Number(verified.paymentPayload.payload.authorization.validBefore) * 1000;
    if (validBefore <= now) {
      // The job completed but the signed authorization ran out before we could settle it: the money is gone.
      logPayment(this.log, 'warn', 'payment proof dropped', {
        reason: 'authorization_expired',
        payer: verified.payer,
        amountUsd: usd(verified.amountMicroUsd),
        job: row.id,
        listing: row.listingId,
      });
      await tasks.clearProof(row.id);
      return 'released';
    }
    try {
      const settled = await this.deps.payments.settle(verified, { jobId: row.id, ...(row.listingId ? { listingId: row.listingId } : {}) });
      await tasks.finishPayment(row.id, settled.transaction);
      return 'settled';
    } catch (err) {
      await tasks.releaseLease(row.id);
      // A facilitator that says no will say no again: stop retrying. Anything else (network) retries next pass.
      if (err instanceof ApiError && err.code === 'PAYMENT_FAILED') await tasks.clearProof(row.id);
      throw err;
    }
  }
}
