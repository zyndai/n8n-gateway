// A small AgentDNS stand-in that enforces the same checks as agent-dns (internal/api/server.go
// handleRegisterEntity, internal/api/heartbeat.go): canonical-JSON registration signature,
// derivation proof against the registered developer key, entity id from the public key, and
// signed heartbeat frames within the clock-skew window. Real HTTP + WebSocket, ephemeral port.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { RegisterEntityBody } from '../../src/services/AgentDnsClient.js';
import { canonicalJson } from '../../src/services/canonical.js';

const bytes = (s: string) => new Uint8Array(Buffer.from(s.replace(/^ed25519:/, ''), 'base64'));
const verify = (pub: string, msg: Uint8Array, sig: string) => {
  try {
    return ed25519.verify(bytes(sig), msg, bytes(pub));
  } catch {
    return false;
  }
};

export interface FakeEntity {
  entity_id: string;
  public_key: string;
  entity_url: string;
  name: string;
  category: string;
  tags: string[];
  summary: string;
  developer_id: string;
  lastHeartbeatAt?: number;
}

export class FakeAgentDns {
  entities = new Map<string, FakeEntity>();
  developers = new Map<string, string>(); // developer_id -> developer public key
  registerCalls = 0;
  validBeats = 0;
  invalidBeats = 0;
  sockets = new Set<import('ws').WebSocket>();
  /** Set to make POST /v1/entities answer 500 (outage). */
  failRegistration = false;
  maxClockSkewS = 60;
  inactiveAfterMs = 300_000;

  private server: Server;
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  url = '';

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const m = /^\/v1\/entities\/([^/]+)\/ws$/.exec(req.url ?? '');
      const entity = m ? this.entities.get(decodeURIComponent(m[1] as string)) : undefined;
      if (!entity) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
        ws.on('message', (data) => this.onBeat(entity, data.toString()));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Drop every heartbeat connection (simulates an AgentDNS restart / network blip). */
  dropSockets(): void {
    for (const s of this.sockets) s.terminate();
  }

  isActive(entityId: string, now = Date.now()): boolean {
    const e = this.entities.get(entityId);
    return !!e?.lastHeartbeatAt && now - e.lastHeartbeatAt <= this.inactiveAfterMs;
  }

  private onBeat(entity: FakeEntity, raw: string): void {
    try {
      const { timestamp, signature } = JSON.parse(raw) as { timestamp: string; signature: string };
      const skew = Math.abs(Date.now() - Date.parse(timestamp));
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(timestamp) || skew > this.maxClockSkewS * 1000) {
        this.invalidBeats++;
        return;
      }
      if (!verify(entity.public_key, new TextEncoder().encode(timestamp), signature)) {
        this.invalidBeats++;
        return;
      }
      entity.lastHeartbeatAt = Date.now();
      this.validBeats++;
    } catch {
      this.invalidBeats++;
    }
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    const get = /^\/v1\/entities\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && get) {
      const e = this.entities.get(decodeURIComponent(get[1] as string));
      return e ? json(200, e) : json(404, { error: 'entity not found' });
    }
    if (req.method !== 'POST' || req.url !== '/v1/entities') return json(404, { error: 'not found' });

    this.registerCalls++;
    if (this.failRegistration) return json(500, { error: 'registry down' });
    const parsed = JSON.parse(raw) as Partial<RegisterEntityBody> & { entity_type?: string };
    const required = ['name', 'entity_url', 'category', 'summary', 'tags', 'public_key', 'signature'] as const;
    const missing = required.filter((k) => parsed[k] === undefined);
    if (missing.length) return json(400, { error: `missing fields: ${missing.join(', ')}` });
    const b = parsed as RegisterEntityBody & { entity_type?: string };

    const signable: Record<string, unknown> = {
      name: b.name, entity_url: b.entity_url, category: b.category, tags: b.tags, summary: b.summary, public_key: b.public_key,
    };
    if (b.entity_type) signable.entity_type = b.entity_type;
    if (!verify(b.public_key, new TextEncoder().encode(canonicalJson(signable)), b.signature)) {
      return json(401, { error: 'invalid agent signature' });
    }
    const devPub = this.developers.get(b.developer_id);
    if (!b.developer_id || !b.developer_proof) return json(400, { error: 'developer_id and developer_proof are required' });
    if (!devPub) return json(400, { error: 'developer_id not found; register developer first' });
    if (devPub !== b.developer_proof.developer_public_key) {
      return json(400, { error: 'developer_proof.developer_public_key does not match registered developer' });
    }
    const msg = new Uint8Array(36);
    msg.set(bytes(b.public_key));
    new DataView(msg.buffer).setUint32(32, b.developer_proof.entity_index, false);
    if (!verify(b.developer_proof.developer_public_key, msg, b.developer_proof.developer_signature)) {
      return json(401, { error: 'invalid developer derivation proof' });
    }

    const entity_id = `zns:${bytesToHex(sha256(bytes(b.public_key)).slice(0, 16))}`;
    if (this.entities.has(entity_id)) return json(409, { error: 'agent already registered' });
    this.entities.set(entity_id, {
      entity_id, public_key: b.public_key, entity_url: b.entity_url, name: b.name, category: b.category,
      tags: b.tags, summary: b.summary, developer_id: b.developer_id,
    });
    return json(201, { entity_id, message: 'agent registered successfully' });
  }
}
