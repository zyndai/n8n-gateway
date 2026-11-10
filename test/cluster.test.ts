// M5.3: heartbeat ownership across Gateway instances.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Cluster, parsePeers, rendezvousOwner } from '../src/services/Cluster.js';
import { HeartbeatCoordinator } from '../src/services/HeartbeatCoordinator.js';
import { HeartbeatManager, type HeartbeatPatch, type HeartbeatSocket, type ResumeTarget } from '../src/services/HeartbeatManager.js';
import { IdentityService, keypairFromSeed } from '../src/services/IdentityService.js';

const entityIds = Array.from({ length: 600 }, (_, i) => `zns:ent:${i.toString(16).padStart(8, '0')}`);

describe('rendezvousOwner', () => {
  it('is deterministic and spreads listings roughly evenly', () => {
    const ids = ['gw-1', 'gw-2'];
    const count = { 'gw-1': 0, 'gw-2': 0 } as Record<string, number>;
    for (const e of entityIds) {
      expect(rendezvousOwner(e, ids)).toBe(rendezvousOwner(e, [...ids].reverse()));
      count[rendezvousOwner(e, ids) as string]!++;
    }
    expect(count['gw-1']).toBeGreaterThan(240);
    expect(count['gw-2']).toBeGreaterThan(240);
  });

  it('moves only the dead instance’s listings, and gives them back when it returns', () => {
    const three = ['gw-1', 'gw-2', 'gw-3'];
    const two = ['gw-1', 'gw-3'];
    for (const e of entityIds) {
      const before = rendezvousOwner(e, three);
      const after = rendezvousOwner(e, two);
      if (before !== 'gw-2') expect(after).toBe(before);
      else expect(two).toContain(after);
      expect(rendezvousOwner(e, three)).toBe(before);
    }
  });

  it('has no owner for an empty list', () => {
    expect(rendezvousOwner('x', [])).toBeUndefined();
  });
});

describe('parsePeers', () => {
  it('parses id=url pairs and trims trailing slashes', () => {
    expect(parsePeers(' gw-2=http://10.0.0.2:8080/ , gw-3=https://gw3.internal ', 'gw-1')).toEqual([
      { id: 'gw-2', url: 'http://10.0.0.2:8080' },
      { id: 'gw-3', url: 'https://gw3.internal' },
    ]);
    expect(parsePeers(undefined, 'gw-1')).toEqual([]);
    expect(parsePeers('  ', 'gw-1')).toEqual([]);
  });

  it('rejects malformed entries, repeats and the instance’s own id', () => {
    for (const bad of ['gw-2', 'gw-2=', '=http://x', 'gw-2=ftp://x', 'gw-2=http://a,gw-2=http://b', 'gw-1=http://self']) {
      expect(() => parsePeers(bad, 'gw-1'), bad).toThrow(/CLUSTER_PEERS/);
    }
  });
});

/** A network of instances whose /health can be switched off. */
function network(ids: string[]) {
  const up = new Set(ids);
  const fetchFor = ((url: string) => {
    const id = ids.find((i) => url.startsWith(`http://${i}`));
    return id && up.has(id) ? Promise.resolve(new Response('{"status":"ok"}')) : Promise.reject(new Error('ECONNREFUSED'));
  }) as unknown as typeof fetch;
  const clusterFor = (self: string, onChange?: (l: string[]) => void) =>
    new Cluster({ selfId: self, peers: ids.filter((i) => i !== self).map((i) => ({ id: i, url: `http://${i}` })), fetch: fetchFor, failThreshold: 2, ...(onChange ? { onChange } : {}) });
  return { up, clusterFor };
}

describe('Cluster liveness', () => {
  it('a single instance owns everything and never probes', async () => {
    const c = new Cluster({ selfId: 'gw-1', peers: [], fetch: (() => { throw new Error('no probes'); }) as never });
    await c.check();
    expect(c.single).toBe(true);
    expect(entityIds.every((e) => c.isOwner(e))).toBe(true);
  });

  it('marks a peer dead after consecutive failures, alive after one success, and reports changes', async () => {
    const net = network(['gw-1', 'gw-2']);
    const changes: string[][] = [];
    const c = net.clusterFor('gw-1', (l) => changes.push(l));
    await c.check();
    expect(c.live()).toEqual(['gw-1', 'gw-2']);

    net.up.delete('gw-2');
    await c.check();
    expect(c.live()).toEqual(['gw-1', 'gw-2']); // one failure is not enough
    await c.check();
    expect(c.live()).toEqual(['gw-1']);
    expect(entityIds.every((e) => c.isOwner(e))).toBe(true);

    net.up.add('gw-2');
    await c.check();
    expect(c.live()).toEqual(['gw-1', 'gw-2']);
    expect(changes).toEqual([['gw-1'], ['gw-1', 'gw-2']]);
  });

  it('treats a non-200 /health as a failure', async () => {
    const c = new Cluster({ selfId: 'gw-1', peers: [{ id: 'gw-2', url: 'http://gw-2' }], failThreshold: 1, fetch: (async () => new Response('', { status: 503 })) as never });
    await c.check();
    expect(c.live()).toEqual(['gw-1']);
  });
});

class Sock extends EventEmitter implements HeartbeatSocket {
  send(_d: string, cb?: (err?: Error) => void) { cb?.(); }
  ping() {}
  close() {}
  terminate() {}
}

function instance(id: string, net: ReturnType<typeof network>, active: { list: ResumeTarget[] }, rows: Map<string, HeartbeatPatch[]>) {
  const identity = new IdentityService();
  const manager = new HeartbeatManager({
    heartbeatUrl: (e) => `ws://dns/${e}`,
    identity,
    store: { record: async (l, p) => void (rows.get(l) ?? rows.set(l, []).get(l)!).push(p) },
    createSocket: () => { const s = new Sock(); queueMicrotask(() => s.emit('open')); return s; },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const cluster = net.clusterFor(id);
  const keyOf = () => keypairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const coordinator = new HeartbeatCoordinator({
    manager, cluster, loadActive: async () => active.list,
    identity: { getListingKeypair: async () => keyOf() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { id, manager, cluster, coordinator };
}

describe('HeartbeatCoordinator across two instances', () => {
  const targets = (n: number): ResumeTarget[] => entityIds.slice(0, n).map((e, i) => ({ listingId: `l${i}`, developerId: 'd', derivedKeyIndex: i, entityId: e }));

  it('splits listings between instances, takes over when one dies and hands back when it returns', async () => {
    const net = network(['gw-1', 'gw-2']);
    const active = { list: targets(100) };
    const rows = new Map<string, HeartbeatPatch[]>();
    const a = instance('gw-1', net, active, rows);
    const b = instance('gw-2', net, active, rows);
    await Promise.all([a.cluster.check(), b.cluster.check()]);
    await Promise.all([a.coordinator.reconcile(), b.coordinator.reconcile()]);

    const all = new Set(active.list.map((t) => t.entityId));
    const held = (i: typeof a) => new Set(i.manager.entityIds());
    expect(a.manager.size + b.manager.size).toBe(100); // each listing on exactly one instance
    expect(a.manager.size).toBeGreaterThan(25);
    expect(b.manager.size).toBeGreaterThan(25);
    for (const e of held(a)) expect(held(b).has(e)).toBe(false);
    expect(new Set([...held(a), ...held(b)])).toEqual(all);

    // gw-2 dies: its sockets vanish with the process, gw-1 notices and takes over
    const gw2Held = [...held(b)];
    b.manager.shutdown();
    net.up.delete('gw-2');
    await a.cluster.check();
    await a.cluster.check();
    const r = await a.coordinator.reconcile();
    expect(r.started).toBe(gw2Held.length);
    expect(a.manager.size).toBe(100);

    // gw-2 returns: it takes its listings back, gw-1 lets them go without writing STOPPED
    net.up.add('gw-2');
    await Promise.all([a.cluster.check(), b.cluster.check()]);
    await Promise.all([a.coordinator.reconcile(), b.coordinator.reconcile()]);
    expect(a.manager.size + b.manager.size).toBe(100);
    expect(new Set(b.manager.entityIds())).toEqual(new Set(gw2Held));
    for (const patches of rows.values()) expect(patches.some((p) => p.status === 'STOPPED')).toBe(false);
    a.manager.shutdown();
    b.manager.shutdown();
  });

  it('start() only opens a socket on the owning instance', async () => {
    const net = network(['gw-1', 'gw-2']);
    const rows = new Map<string, HeartbeatPatch[]>();
    const a = instance('gw-1', net, { list: [] }, rows);
    const kp = keypairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    for (const e of entityIds.slice(0, 40)) a.coordinator.start({ listingId: e, entityId: e, keypair: kp });
    expect(a.manager.size).toBeGreaterThan(0);
    expect(a.manager.size).toBeLessThan(40);
    expect(a.manager.entityIds().every((e) => rendezvousOwner(e, ['gw-1', 'gw-2']) === 'gw-1')).toBe(true);
    a.manager.shutdown();
  });

  it('stops a listing deactivated elsewhere, but only after it stays missing for two rounds', async () => {
    const net = network(['gw-1']);
    const t = targets(1);
    const active = { list: t };
    const rows = new Map<string, HeartbeatPatch[]>();
    const a = instance('gw-1', net, active, rows);
    await a.coordinator.reconcile();
    expect(a.manager.size).toBe(1);

    active.list = [];
    expect((await a.coordinator.reconcile()).stopped).toBe(0);
    expect(a.manager.size).toBe(1);
    expect((await a.coordinator.reconcile()).stopped).toBe(1);
    expect(a.manager.size).toBe(0);
    expect(rows.get('l0')!.at(-1)!.status).toBe('STOPPED');

    active.list = t; // activated again: comes back
    await a.coordinator.reconcile();
    expect(a.manager.size).toBe(1);
    a.manager.shutdown();
  });

  it('a listing that reappears between rounds is not stopped', async () => {
    const net = network(['gw-1']);
    const t = targets(1);
    const active = { list: t };
    const a = instance('gw-1', net, active, new Map());
    await a.coordinator.reconcile();
    active.list = [];
    await a.coordinator.reconcile();
    active.list = t;
    await a.coordinator.reconcile();
    active.list = [];
    expect((await a.coordinator.reconcile()).stopped).toBe(0); // the counter restarted
    a.manager.shutdown();
  });
});
