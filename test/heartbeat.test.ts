import { ed25519 } from '@noble/curves/ed25519.js';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatManager, type HeartbeatPatch, type HeartbeatSocket, type HeartbeatStore } from '../src/services/HeartbeatManager.js';
import { IdentityService, keypairFromSeed } from '../src/services/IdentityService.js';

class FakeSocket extends EventEmitter implements HeartbeatSocket {
  sent: { timestamp: string; signature: string }[] = [];
  pings = 0;
  closed = false;
  terminated = false;
  failSends = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    cb?.(this.failSends ? new Error('send failed') : undefined);
  }
  ping(): void {
    this.pings++;
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.terminated = true;
  }
  // helpers
  open() {
    this.emit('open');
  }
  pong() {
    this.emit('pong');
  }
  drop() {
    this.emit('close', 1006);
  }
}

const keypair = keypairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
const identity = new IdentityService();
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function setup(extra: Partial<ConstructorParameters<typeof HeartbeatManager>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const records: { listingId: string; patch: HeartbeatPatch }[] = [];
  const store: HeartbeatStore = {
    async record(listingId, patch) {
      records.push({ listingId, patch });
    },
  };
  const mgr = new HeartbeatManager({
    heartbeatUrl: (id) => `wss://dns.test/v1/entities/${id}/ws`,
    identity,
    store,
    log: silent,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    ...extra,
  });
  const last = () => sockets[sockets.length - 1] as FakeSocket;
  const statuses = () => records.map((r) => r.patch.status);
  return { mgr, sockets, records, last, statuses };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const start = (mgr: HeartbeatManager) => mgr.start({ listingId: 'L1', entityId: 'zns:abc', keypair });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-10T02:30:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('beats (M1.9)', () => {
  it('connects to the entity ws URL, beats immediately and every 30 s with a valid signature', async () => {
    const { mgr, sockets, last, records } = setup();
    start(mgr);
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('wss://dns.test/v1/entities/zns:abc/ws');
    expect(last().sent).toHaveLength(0); // nothing before the socket opens

    last().open();
    expect(last().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(last().sent).toHaveLength(1);
    last().pong();
    await vi.advanceTimersByTimeAsync(1);
    expect(last().sent).toHaveLength(2);
    last().pong();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(last().sent).toHaveLength(3);

    for (const frame of last().sent) {
      const sig = Buffer.from(frame.signature.slice('ed25519:'.length), 'base64');
      expect(ed25519.verify(sig, new TextEncoder().encode(frame.timestamp), keypair.publicKey)).toBe(true);
      expect(frame.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    }
    // lastBeatAt is written on every successful beat
    const beats = records.filter((r) => r.patch.lastBeatAt);
    expect(beats).toHaveLength(3);
    expect(beats.map((b) => b.patch.lastBeatAt?.toISOString())).toEqual([
      '2026-11-10T02:30:00.000Z',
      '2026-11-10T02:30:30.000Z',
      '2026-11-10T02:31:00.000Z',
    ]);
    expect(records[0]?.patch.status).toBe('CONNECTING');
    expect(records[1]?.patch.status).toBe('ACTIVE');
  });

  it('start() is idempotent', () => {
    const { mgr, sockets } = setup();
    start(mgr);
    start(mgr);
    expect(sockets).toHaveLength(1);
    expect(mgr.size).toBe(1);
  });
});

describe('reconnect with backoff (M1.10)', () => {
  it('retries after 1, 2, 4, 8 s, flags FAILED on the 5th failure, then keeps retrying capped at 30 s', async () => {
    const { mgr, sockets, last, records, statuses } = setup();
    start(mgr);

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, delay] of delays.entries()) {
      last().drop(); // failure i+1 (connection never opened, like a refused connection)
      const before = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets, `no retry before ${delay} ms`).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets, `retry at ${delay} ms`).toHaveLength(before + 1);

      const expectStatus = i + 1 >= 5 ? 'FAILED' : 'RECONNECTING';
      const rec = records.filter((r) => r.patch.failCount === i + 1).at(-1);
      expect(rec?.patch.status).toBe(expectStatus);
    }
    expect(statuses().filter((s) => s === 'FAILED').length).toBeGreaterThanOrEqual(1);
    expect(statuses().indexOf('FAILED')).toBe(
      records.findIndex((r) => r.patch.failCount === 5),
    );
  });

  it('treats a socket error the same as a close, and only counts it once', async () => {
    const { mgr, last, records } = setup();
    start(mgr);
    last().emit('error', new Error('ECONNREFUSED'));
    last().drop(); // 'close' follows 'error' on a real socket
    await flush();
    expect(records.filter((r) => r.patch.failCount === 1)).toHaveLength(1);
    expect(records.filter((r) => r.patch.failCount === 2)).toHaveLength(0);
  });

  it('recovers to ACTIVE after a reconnect and resets the counter once the connection lives through a second beat', async () => {
    const { mgr, sockets, last, records } = setup();
    start(mgr);
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    last().open();
    await flush();
    expect(records.at(-1)?.patch).toMatchObject({ status: 'ACTIVE', failCount: 1 }); // not reset yet
    last().pong();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(records.at(-1)?.patch).toMatchObject({ status: 'ACTIVE', failCount: 0 });

    // the next drop starts the backoff over at 1 s
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(3);
  });

  it('backs off a server that accepts then drops instead of retrying at 1 s forever', async () => {
    const { mgr, sockets, last } = setup();
    start(mgr);
    const gaps: number[] = [];
    let expected = 1000;
    for (let i = 0; i < 4; i++) {
      last().open();
      last().drop();
      const n = sockets.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(sockets).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(n + 1);
      gaps.push(expected);
      expected *= 2;
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('fails when the pong for the previous beat never arrives (half-open connection)', async () => {
    const { mgr, sockets, last, records } = setup();
    start(mgr);
    last().open(); // beat 1 + ping, no pong ever
    const first = last();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.terminated).toBe(true);
    expect(records.at(-1)?.patch).toMatchObject({ status: 'RECONNECTING', failCount: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it('fails when a send errors', async () => {
    const { mgr, last, records } = setup();
    start(mgr);
    last().failSends = true;
    last().open();
    await flush();
    expect(records.at(-1)?.patch).toMatchObject({ status: 'RECONNECTING', failCount: 1 });
  });

  it('a late error on a discarded socket does not throw', () => {
    const { mgr, last } = setup();
    start(mgr);
    const s = last();
    s.drop();
    expect(() => s.emit('error', new Error('late'))).not.toThrow();
  });

  it('survives createSocket throwing', async () => {
    let n = 0;
    const { mgr, records } = setup({
      createSocket: () => {
        n++;
        throw new Error('bad url');
      },
    });
    start(mgr);
    await flush();
    expect(records.at(-1)?.patch).toMatchObject({ status: 'RECONNECTING', failCount: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(2);
  });
});

describe('stop / shutdown (M1.9)', () => {
  it('stop() closes the socket, marks STOPPED, and cancels all timers', async () => {
    const { mgr, sockets, last, records } = setup();
    start(mgr);
    last().open();
    const s = last();
    await mgr.stop('zns:abc');
    expect(s.closed).toBe(true);
    expect(records.at(-1)?.patch.status).toBe('STOPPED');
    expect(mgr.has('zns:abc')).toBe(false);

    const sentBefore = s.sent.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.sent).toHaveLength(sentBefore);
    expect(sockets).toHaveLength(1);
  });

  it('stop() during a backoff wait cancels the reconnect', async () => {
    const { mgr, sockets, last } = setup();
    start(mgr);
    last().drop();
    await mgr.stop('zns:abc');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('stop() of an unknown entity is a no-op', async () => {
    const { mgr, records } = setup();
    await mgr.stop('zns:nope');
    expect(records).toHaveLength(0);
  });

  it('persists writes per listing in order, so STOPPED is never overwritten by a late ACTIVE', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { mgr, last } = setup({
      store: {
        async record(_id, patch) {
          if (patch.status === 'ACTIVE') await gate; // slow write
          order.push(patch.status);
        },
      },
    });
    start(mgr);
    last().open(); // ACTIVE write is now stuck
    const stopped = mgr.stop('zns:abc');
    release();
    await stopped;
    expect(order).toEqual(['CONNECTING', 'ACTIVE', 'STOPPED']);
  });

  it('shutdown() closes every socket without writing to the DB', () => {
    const { mgr, sockets, records } = setup();
    mgr.start({ listingId: 'A', entityId: 'zns:a', keypair });
    mgr.start({ listingId: 'B', entityId: 'zns:b', keypair });
    const before = records.length;
    mgr.shutdown();
    expect(sockets.every((s) => s.closed)).toBe(true);
    expect(records).toHaveLength(before);
    expect(mgr.size).toBe(0);
  });
});

describe('startup recovery (M1.11)', () => {
  it('starts every ACTIVE listing and isolates failures', async () => {
    const targets = [1, 2, 3].map((n) => ({
      listingId: `L${n}`,
      developerId: 'zns:dev:1',
      derivedKeyIndex: n,
      entityId: `zns:e${n}`,
    }));
    const { mgr, sockets, records } = setup({
      loadActive: async () => targets,
      identity: {
        signHeartbeat: identity.signHeartbeat.bind(identity),
        async getListingKeypair(ref) {
          if (ref.listingId === 'L2') throw new Error('cannot decrypt');
          return keypair;
        },
      },
    });
    const result = await mgr.resumeActive();
    expect(result).toEqual({ started: 2, failed: 1 });
    expect(sockets.map((s) => s.url)).toEqual([
      'wss://dns.test/v1/entities/zns:e1/ws',
      'wss://dns.test/v1/entities/zns:e3/ws',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.find((r) => r.listingId === 'L2')?.patch.status).toBe('FAILED');
  });

  it('does nothing without a loader', async () => {
    const { mgr } = setup();
    expect(await mgr.resumeActive()).toEqual({ started: 0, failed: 0 });
  });
});
