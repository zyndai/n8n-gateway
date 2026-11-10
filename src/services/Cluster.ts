// M5.3: which Gateway instance holds a listing's AgentDNS heartbeat socket.
//
// Only heartbeats need an owner. HTTP (A2A, /n8n/v1, /internal/v1) is stateless on every instance,
// because tasks live in Postgres, so any instance behind the load balancer can serve any request.
// Each listing's socket is placed by rendezvous (highest random weight) hashing on its entity id
// over the instances that are alive: a listing only moves when the instance holding it dies or
// returns, and the instances agree without talking to each other.
//
// Liveness is each instance probing its peers' `GET /health`. A peer is dead after `failThreshold`
// failures in a row and alive again after one success. Probes failing for a reason that is not a
// dead peer (a wrong URL, a partition) make an instance claim listings its peer also holds. That
// costs a duplicate socket, which AgentDNS accepts; the other way round (a listing nobody holds)
// cannot come from a failed probe, so the failure direction is the harmless one.
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export interface Peer {
  id: string;
  /** Base URL of the peer, e.g. `http://10.0.0.2:8080`. */
  url: string;
}

const weight = (instanceId: string, entityId: string): bigint => {
  const h = sha256(utf8ToBytes(`${instanceId}\0${entityId}`));
  let w = 0n;
  for (let i = 0; i < 8; i++) w = (w << 8n) | BigInt(h[i] as number);
  return w;
};

/** The instance that owns `entityId` among `ids` (highest weight; ties break on id). Undefined for an empty list. */
export function rendezvousOwner(entityId: string, ids: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestW = -1n;
  for (const id of ids) {
    const w = weight(id, entityId);
    if (w > bestW || (w === bestW && best !== undefined && id < best)) {
      best = id;
      bestW = w;
    }
  }
  return best;
}

/** `gw-2=http://10.0.0.2:8080,gw-3=http://10.0.0.3:8080` -> peers. Throws on a malformed list. */
export function parsePeers(raw: string | undefined, selfId: string): Peer[] {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>([selfId]);
  return raw.split(',').map((part) => {
    const eq = part.indexOf('=');
    const id = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim().replace(/\/+$/, '');
    if (eq < 1 || !id || !/^https?:\/\/\S+$/.test(url)) throw new Error(`Invalid CLUSTER_PEERS entry "${part.trim()}": expected id=http://host:port`);
    if (seen.has(id)) throw new Error(`Invalid CLUSTER_PEERS: instance id "${id}" is repeated or equals INSTANCE_ID`);
    seen.add(id);
    return { id, url };
  });
}

export interface ClusterOptions {
  selfId: string;
  peers: Peer[];
  fetch?: typeof fetch;
  /** Time between probe rounds. */
  intervalMs?: number;
  /** Per-probe deadline. */
  timeoutMs?: number;
  /** Consecutive failed probes before a peer counts as dead. */
  failThreshold?: number;
  /** Called after the live set changed. */
  onChange?: (live: string[]) => void;
}

export class Cluster {
  private readonly dead = new Set<string>();
  private readonly failures = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failThreshold: number;

  constructor(private readonly opts: ClusterOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.timeoutMs = opts.timeoutMs ?? 2_000;
    this.failThreshold = opts.failThreshold ?? 2;
  }

  get selfId(): string {
    return this.opts.selfId;
  }

  /** True when this instance runs alone, so it owns everything and never probes. */
  get single(): boolean {
    return this.opts.peers.length === 0;
  }

  /** Live instance ids, always including this one. */
  live(): string[] {
    return [this.opts.selfId, ...this.opts.peers.filter((p) => !this.dead.has(p.id)).map((p) => p.id)];
  }

  isOwner(entityId: string): boolean {
    return rendezvousOwner(entityId, this.live()) === this.opts.selfId;
  }

  /** Probe every peer once. Resolves after the live set (and `onChange`) is up to date. */
  async check(): Promise<void> {
    if (this.single) return;
    const before = this.live().join();
    await Promise.all(this.opts.peers.map((p) => this.probe(p)));
    if (this.live().join() !== before) this.opts.onChange?.(this.live());
  }

  start(): void {
    if (this.single || this.timer) return;
    this.timer = setInterval(() => void this.check().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async probe(peer: Peer): Promise<void> {
    let ok = false;
    try {
      const res = await this.fetchFn(`${peer.url}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
      ok = res.status === 200;
      void res.body?.cancel().catch(() => undefined);
    } catch {
      ok = false;
    }
    if (ok) {
      this.failures.set(peer.id, 0);
      this.dead.delete(peer.id);
      return;
    }
    const n = (this.failures.get(peer.id) ?? 0) + 1;
    this.failures.set(peer.id, n);
    if (n >= this.failThreshold) this.dead.add(peer.id);
  }
}
