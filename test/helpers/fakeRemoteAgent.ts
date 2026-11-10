// A remote Zynd agent for outbound-call tests. It verifies exactly what a real one would:
// x-zynd-auth on every message (same verifier the Gateway uses inbound, cross-checked against the
// TS SDK) and, when priced, an x402 payment via PaymentProcessor.verifyX402.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config.js';
import { PaymentProcessor, type PaymentRequirements } from '../../src/services/PaymentProcessor.js';
import { verifyZyndAuth, type A2AMessage } from '../../src/services/zyndAuth.js';
import { MemoryNonces } from './memoryStores.js';

export interface RemoteOptions {
  /** USD price; unset = free. */
  priceUsd?: string;
  /** What to do with an accepted message. */
  mode?: 'task-completed' | 'task-working-then-done' | 'message' | 'task-failed' | 'rpc-error' | 'never-finishes';
  /** HTTP status to answer a PAID request with, to simulate a refusal. */
  paidStatus?: number;
}

export class FakeRemoteAgent {
  readonly nonces = new MemoryNonces();
  readonly payments = new PaymentProcessor({
    config: loadConfig({}).x402,
    fetch: (async () => Response.json({ isValid: true, success: true, transaction: '0xremote' })) as unknown as typeof fetch,
  });
  readonly payTo = this.payments.evmAddress(Uint8Array.from({ length: 32 }, (_, i) => i + 200));
  requests: { method: string; auth: boolean; paid: boolean; params: unknown }[] = [];
  polls = 0;
  receivedMessages: A2AMessage[] = [];
  /** Payers that were successfully verified. */
  payers: string[] = [];
  url = '';
  private server: Server;

  constructor(public opts: RemoteOptions = {}) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => void this.handle(req.headers, Buffer.concat(chunks).toString('utf8'), res));
    });
  }

  get requirements(): PaymentRequirements {
    return this.payments.requirementsFor(this.payTo, this.opts.priceUsd as string);
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private async handle(headers: import('node:http').IncomingHttpHeaders, raw: string, res: import('node:http').ServerResponse) {
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(body));
    };
    const rpc = JSON.parse(raw) as { id: string; method: string; params: { message?: A2AMessage; id?: string } };
    const result = (r: unknown, extra: Record<string, string> = {}) => send(200, { jsonrpc: '2.0', id: rpc.id, result: r }, extra);
    const task = (state: string, withOutput = false) => ({
      kind: 'task', id: 'remote-task-1', contextId: 'remote-ctx', status: { state, ...(state === 'failed' ? { message: { kind: 'message', messageId: 'x', role: 'agent', parts: [{ kind: 'text', text: 'remote exploded' }] } } : {}) },
      ...(withOutput ? { artifacts: [{ artifactId: 'a', parts: [{ kind: 'data', data: { answer: 42 } }] }] } : {}),
    });

    if (rpc.method === 'tasks/get') {
      this.polls++;
      this.requests.push({ method: rpc.method, auth: false, paid: false, params: rpc.params });
      return result(this.polls >= 2 && this.opts.mode !== 'never-finishes' ? task('completed', true) : task('working'));
    }

    const message = rpc.params.message as A2AMessage;
    let auth = true;
    try {
      await verifyZyndAuth(message, this.nonces);
    } catch (e) {
      auth = false;
      this.requests.push({ method: rpc.method, auth, paid: false, params: rpc.params });
      return send(401, { jsonrpc: '2.0', id: rpc.id, error: { code: -32100, message: (e as Error).message } });
    }

    let paid = false;
    if (this.opts.priceUsd) {
      if (!headers['payment-signature']) {
        this.requests.push({ method: rpc.method, auth, paid, params: rpc.params });
        return send(402, { error: 'payment required' }, { 'PAYMENT-REQUIRED': this.payments.paymentRequiredHeader(this.requirements, this.url) });
      }
      try {
        const v = await this.payments.verifyX402(headers as Record<string, string>, this.requirements);
        this.payers.push(v.payer);
        paid = true;
      } catch (e) {
        this.requests.push({ method: rpc.method, auth, paid, params: rpc.params });
        return send(402, { error: (e as Error).message }, { 'PAYMENT-REQUIRED': this.payments.paymentRequiredHeader(this.requirements, this.url) });
      }
      if (this.opts.paidStatus) {
        this.requests.push({ method: rpc.method, auth, paid, params: rpc.params });
        return send(this.opts.paidStatus, { error: 'refused' });
      }
    }
    this.requests.push({ method: rpc.method, auth, paid, params: rpc.params });
    this.receivedMessages.push(message);

    const settled: Record<string, string> = paid ? { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: '0xremote' })).toString('base64') } : {};
    switch (this.opts.mode ?? 'task-completed') {
      case 'task-completed':
        return result(task('completed', true), settled);
      case 'task-working-then-done':
        return result(task('working'), settled);
      case 'never-finishes':
        return result(task('working'), settled);
      case 'task-failed':
        return result(task('failed'), settled);
      case 'message':
        return result({ kind: 'message', messageId: 'r1', role: 'agent', parts: [{ kind: 'text', text: 'pong' }] }, settled);
      case 'rpc-error':
        return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'bad input' } });
    }
  }
}
