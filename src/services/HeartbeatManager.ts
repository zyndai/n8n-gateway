// LLD > HeartbeatManager (M1.9-M1.11). One persistent WebSocket per active listing to
// AgentDNS `/v1/entities/{id}/ws`, a signed `{timestamp, signature}` frame every 30 s.
//
// Deliberate choices beyond the LLD text:
//  - FAILED is a status, not a terminal state. After the 5th consecutive failure the status is
//    FAILED (as specified) but retries continue at the 30 s cap, so an AgentDNS outage longer
//    than ~15 s does not strand every agent until the Gateway restarts.
//  - The failure counter resets only once a connection has survived a full beat interval, so a
//    server that accepts and immediately drops backs off instead of being hammered at 1 s.
//  - A ping goes out with every beat; a missing pong by the next beat counts as a failure, which
//    catches half-open TCP connections that never raise 'close'.
import type { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Ed25519Keypair, IdentityService, ListingKeyRef } from './IdentityService.js';

export type HeartbeatStatus = 'CONNECTING' | 'ACTIVE' | 'RECONNECTING' | 'FAILED' | 'STOPPED';

export interface HeartbeatPatch {
  status: HeartbeatStatus;
  lastBeatAt?: Date;
  failCount?: number;
}

/** Persists N8nHeartbeat rows (keyed by listingId). */
export interface HeartbeatStore {
  record(listingId: string, patch: HeartbeatPatch): Promise<void>;
}

export interface HeartbeatSocket extends EventEmitter {
  send(data: string, cb?: (err?: Error) => void): void;
  ping(): void;
  close(): void;
  terminate(): void;
}

export interface ResumeTarget extends ListingKeyRef {
  entityId: string;
}

export interface HeartbeatOptions {
  /** `wss://…/v1/entities/{id}/ws` for an entity. */
  heartbeatUrl: (entityId: string) => string;
  identity: Pick<IdentityService, 'signHeartbeat' | 'getListingKeypair'>;
  store: HeartbeatStore;
  /** Active listings to resume on boot (M1.11). */
  loadActive?: () => Promise<ResumeTarget[]>;
  createSocket?: (url: string) => HeartbeatSocket;
  intervalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxFailures?: number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface HeartbeatStart {
  listingId: string;
  entityId: string;
  keypair: Ed25519Keypair;
}

interface Entry extends HeartbeatStart {
  socket?: HeartbeatSocket;
  interval?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  failCount: number;
  beatsOnConnection: number;
  awaitingPong: boolean;
  stopped: boolean;
}

const noop = (): void => {};

export class HeartbeatManager {
  private readonly entries = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly intervalMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxFailures: number;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly createSocket: (url: string) => HeartbeatSocket;

  constructor(private readonly opts: HeartbeatOptions) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.log = opts.log ?? console;
    this.createSocket =
      opts.createSocket ??
      ((url) =>
        // permessage-deflate allocates a zlib context per socket; the frames are ~150 bytes.
        new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10_000 }) as unknown as HeartbeatSocket);
  }

  get size(): number {
    return this.entries.size;
  }

  has(entityId: string): boolean {
    return this.entries.has(entityId);
  }

  /** Open the socket and start beating. Idempotent: a running entity is left alone. */
  start(args: HeartbeatStart): void {
    if (this.entries.has(args.entityId)) return;
    const entry: Entry = { ...args, failCount: 0, beatsOnConnection: 0, awaitingPong: false, stopped: false };
    this.entries.set(args.entityId, entry);
    void this.persist(entry.listingId, { status: 'CONNECTING', failCount: 0 });
    this.connect(entry);
  }

  /** Close the socket, mark the row STOPPED (G8) and forget the entity. */
  async stop(entityId: string): Promise<void> {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.stopped = true;
    this.entries.delete(entityId);
    this.teardown(entry);
    await this.persist(entry.listingId, { status: 'STOPPED' });
  }

  /** Process shutdown: close everything without touching the DB, so listings resume on restart. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      this.teardown(entry);
    }
    this.entries.clear();
  }

  /** M1.11: resume heartbeats for every ACTIVE listing. One bad listing never blocks the rest. */
  async resumeActive(): Promise<{ started: number; failed: number }> {
    if (!this.opts.loadActive) return { started: 0, failed: 0 };
    const targets = await this.opts.loadActive();
    let started = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        const keypair = await this.opts.identity.getListingKeypair(t);
        this.start({ listingId: t.listingId, entityId: t.entityId, keypair });
        started++;
      } catch (err) {
        failed++;
        this.log.error(`heartbeat resume failed for listing ${t.listingId}: ${(err as Error).message}`);
        void this.persist(t.listingId, { status: 'FAILED' });
      }
    }
    this.log.info(`heartbeats resumed: ${started} started, ${failed} failed`);
    return { started, failed };
  }

  // --- internals ---------------------------------------------------------------------------

  private connect(entry: Entry): void {
    if (entry.stopped) return;
    entry.retryTimer = undefined;
    entry.beatsOnConnection = 0;
    entry.awaitingPong = false;

    let socket: HeartbeatSocket;
    try {
      socket = this.createSocket(this.opts.heartbeatUrl(entry.entityId));
    } catch (err) {
      this.onFailure(entry, undefined, (err as Error).message);
      return;
    }
    entry.socket = socket;

    let done = false;
    const fail = (reason: string): void => {
      if (done) return;
      done = true;
      this.onFailure(entry, socket, reason);
    };
    socket.on('open', () => {
      if (entry.stopped || entry.socket !== socket) return;
      this.beat(entry, socket, fail);
      entry.interval = setInterval(() => this.tick(entry, socket, fail), this.intervalMs);
    });
    socket.on('pong', () => {
      entry.awaitingPong = false;
    });
    socket.on('error', (err: Error) => fail(err.message));
    socket.on('close', () => fail('connection closed'));
  }

  private tick(entry: Entry, socket: HeartbeatSocket, fail: (reason: string) => void): void {
    if (entry.stopped || entry.socket !== socket) return;
    if (entry.awaitingPong) {
      fail('no pong since last beat');
      return;
    }
    this.beat(entry, socket, fail);
  }

  private beat(entry: Entry, socket: HeartbeatSocket, fail: (reason: string) => void): void {
    try {
      const frame = this.opts.identity.signHeartbeat(entry.keypair);
      entry.awaitingPong = true;
      socket.ping();
      socket.send(JSON.stringify(frame), (err) => {
        if (err) {
          fail(err.message);
          return;
        }
        if (entry.stopped || entry.socket !== socket) return;
        entry.beatsOnConnection++;
        // Backoff resets once the connection has lived through a second beat.
        if (entry.beatsOnConnection >= 2) entry.failCount = 0;
        void this.persist(entry.listingId, { status: 'ACTIVE', lastBeatAt: new Date(), failCount: entry.failCount });
      });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  private onFailure(entry: Entry, socket: HeartbeatSocket | undefined, reason: string): void {
    if (socket) this.discard(socket);
    if (entry.interval) clearInterval(entry.interval);
    entry.interval = undefined;
    if (entry.stopped || (socket && entry.socket !== socket)) return;
    entry.socket = undefined;

    entry.failCount++;
    const status: HeartbeatStatus = entry.failCount >= this.maxFailures ? 'FAILED' : 'RECONNECTING';
    const delay = Math.min(this.baseDelayMs * 2 ** (entry.failCount - 1), this.maxDelayMs);
    this.log.warn(`heartbeat ${entry.entityId}: ${reason} (failure ${entry.failCount}, ${status}, retry in ${delay} ms)`);
    void this.persist(entry.listingId, { status, failCount: entry.failCount });
    entry.retryTimer = setTimeout(() => this.connect(entry), delay);
  }

  private teardown(entry: Entry): void {
    if (entry.interval) clearInterval(entry.interval);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.interval = entry.retryTimer = undefined;
    if (entry.socket) this.discard(entry.socket, true);
    entry.socket = undefined;
  }

  /** Detach and kill a socket. A late 'error' on a detached socket would otherwise throw. */
  private discard(socket: HeartbeatSocket, graceful = false): void {
    socket.removeAllListeners();
    socket.on('error', noop);
    try {
      if (graceful) socket.close();
      else socket.terminate();
    } catch {
      // already closed
    }
  }

  /** Writes for one listing are serialised so a late ACTIVE can never overwrite STOPPED. */
  private persist(listingId: string, patch: HeartbeatPatch): Promise<void> {
    const prev = this.chains.get(listingId) ?? Promise.resolve();
    const next = prev
      .then(() => this.opts.store.record(listingId, patch))
      .catch((err: unknown) => this.log.error(`heartbeat persist failed for ${listingId}: ${(err as Error).message}`));
    this.chains.set(listingId, next);
    void next.then(() => {
      if (this.chains.get(listingId) === next) this.chains.delete(listingId);
    });
    return next;
  }
}
