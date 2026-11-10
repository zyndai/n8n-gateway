// M5.3: runs this instance's share of the heartbeats (see Cluster). It sits where HeartbeatManager
// used to be wired and keeps the same start/stop surface, so ListingService does not change.
//
//  - start(): a listing activated through this instance is only started here if this instance owns
//    it; otherwise the owner picks it up on its next reconcile.
//  - reconcile(): reads the ACTIVE listings from Postgres and makes this instance run exactly the
//    ones it owns. It starts missing ones (boot, activation elsewhere, a peer that died), stops ones
//    it no longer owns (a peer came back) and stops ones that are no longer active (deactivated or
//    deleted through another instance), after they stay missing for two rounds so a listing that is
//    mid-activation is not cut off.
import type { HeartbeatManager, HeartbeatStart, ResumeTarget } from './HeartbeatManager.js';
import type { Cluster } from './Cluster.js';
import type { IdentityService } from './IdentityService.js';

export interface CoordinatorOptions {
  manager: Pick<HeartbeatManager, 'start' | 'stop' | 'release' | 'has' | 'entityIds' | 'size'>;
  cluster: Pick<Cluster, 'isOwner'>;
  loadActive: () => Promise<ResumeTarget[]>;
  identity: Pick<IdentityService, 'getListingKeypair'>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface ReconcileResult {
  started: number;
  stopped: number;
  failed: number;
}

export class HeartbeatCoordinator {
  private readonly missing = new Set<string>();
  private running: Promise<ReconcileResult> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(private readonly opts: CoordinatorOptions) {
    this.log = opts.log ?? console;
  }

  get size(): number {
    return this.opts.manager.size;
  }

  start(args: HeartbeatStart): void {
    if (this.opts.cluster.isOwner(args.entityId)) this.opts.manager.start(args);
  }

  stop(entityId: string): Promise<void> {
    return this.opts.manager.stop(entityId);
  }

  /** One pass. Calls overlap safely: a second call while one runs returns the first's result. */
  reconcile(): Promise<ReconcileResult> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Reconcile now and then every `intervalMs`. */
  begin(intervalMs: number): void {
    const run = (): void => void this.reconcile().catch((err: unknown) => this.log.error(`heartbeat reconcile failed: ${(err as Error).message}`));
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async pass(): Promise<ReconcileResult> {
    const { manager, cluster, identity } = this.opts;
    const targets = await this.opts.loadActive();
    const active = new Set(targets.map((t) => t.entityId));
    let started = 0;
    let stopped = 0;
    let failed = 0;

    for (const t of targets) {
      if (!cluster.isOwner(t.entityId) || manager.has(t.entityId)) continue;
      try {
        manager.start({ listingId: t.listingId, entityId: t.entityId, keypair: await identity.getListingKeypair(t) });
        started++;
      } catch (err) {
        failed++;
        this.log.error(`heartbeat start failed for listing ${t.listingId}: ${(err as Error).message}`);
      }
    }

    for (const entityId of manager.entityIds()) {
      if (!cluster.isOwner(entityId)) {
        this.missing.delete(entityId);
        manager.release(entityId);
        stopped++;
      } else if (!active.has(entityId)) {
        if (this.missing.has(entityId)) {
          this.missing.delete(entityId);
          await manager.stop(entityId);
          stopped++;
        } else {
          this.missing.add(entityId);
        }
      } else {
        this.missing.delete(entityId);
      }
    }

    if (started || stopped || failed) this.log.info(`heartbeats reconciled: ${started} started, ${stopped} stopped, ${failed} failed, ${manager.size} running`);
    return { started, stopped, failed };
  }
}
