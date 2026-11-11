// Outbound paid calls (M2.14-M2.16, HLD flow 2): n8n asks the Gateway to call another Zynd agent.
// The Gateway signs as the developer (G3: the developer master key, not a listing key), answers an
// x402 challenge within the caller's limits, and returns the result. No key material reaches n8n.
//
//   POST entity_url/a2a/v1  message/send (+ x-zynd-auth)
//     -> 402 + PAYMENT-REQUIRED        read the price
//        check <= maxPaymentUsd, reserve it on the API key (atomic, PAYMENT_CAP if over the cap)
//        POST again with PAYMENT-SIGNATURE and a fresh x-zynd-auth
//     -> Task / Message                poll tasks/get every 2 s until terminal (300 s cap)
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { AuthedApiKey } from '../middleware/apiKeyAuth.js';
import type { ApiKeyStoreLike } from './ApiKeyStore.js';
import { deriveInput } from './A2AHandler.js';
import type { AgentDnsClient } from './AgentDnsClient.js';
import { AgentDnsError } from './AgentDnsClient.js';
import type { Ed25519Keypair, IdentityService } from './IdentityService.js';
import type { ListingStoreLike } from './ListingStore.js';
import { atomicToMicroUsd, formatUsd, parseUsd } from './money.js';
import type { PaymentProcessor } from './PaymentProcessor.js';
import { logPayment, reasonFromBody, usd, type PaymentLogger } from './paymentLog.js';
import type { TaskRow, TaskStoreLike } from './TaskStore.js';
import { signZyndAuth, type A2AMessage } from './zyndAuth.js';

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);

export interface AgentCallerDeps {
  agentDns: Pick<AgentDnsClient, 'getEntity'>;
  identity: Pick<IdentityService, 'withDeveloperKeypair' | 'getListingKeypair'>;
  /** Resolves `payFromListingId`. Without it, calls always pay from the developer wallet. */
  store?: Pick<ListingStoreLike, 'getOwned'>;
  payments: Pick<PaymentProcessor, 'signX402' | 'parsePaymentRequired' | 'parsePaymentResponse'>;
  tasks: TaskStoreLike;
  apiKeys: Pick<ApiKeyStoreLike, 'reserveSpend' | 'refundSpend'>;
  /** Used when the caller sends no `maxPaymentUsd`. */
  defaultMaxPaymentUsd: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Payment log lines (one per event). Defaults to `console`. */
  log?: PaymentLogger;
}

export interface OutboundResult {
  taskId: string;
  status: TaskRow['status'];
  output: unknown;
  error: string | null;
  paymentUsd: string | null;
  paymentTxn: string | null;
}

export interface CallInput {
  input: unknown;
  maxPaymentUsd?: unknown;
  /** Pay from this listing's wallet (one of the caller's) instead of the developer wallet. Auth is still the developer's. */
  payFromListingId?: unknown;
}

interface RpcReply {
  status: number;
  headers: Headers;
  json: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function a2aEndpoint(entityUrl: string | undefined): string {
  if (!entityUrl) throw new ApiError('GATEWAY_UNAVAILABLE', 'Agent has no endpoint registered');
  let u: URL;
  try {
    u = new URL(entityUrl);
  } catch {
    throw new ApiError('GATEWAY_UNAVAILABLE', 'Agent endpoint is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ApiError('GATEWAY_UNAVAILABLE', 'Agent endpoint must be http(s)');
  const base = u.toString().replace(/\/+$/, '');
  return base.endsWith('/a2a/v1') ? base : `${base}/a2a/v1`;
}

function outboundMessage(input: unknown): A2AMessage {
  const part = typeof input === 'string' ? { kind: 'text', text: input } : { kind: 'data', data: input ?? {} };
  return { kind: 'message', messageId: randomUUID(), role: 'user', parts: [part] };
}

export class AgentCaller {
  private readonly fetchImpl: typeof fetch;
  private readonly log: PaymentLogger;

  constructor(private readonly deps: AgentCallerDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.log = deps.log ?? console;
  }

  /** M2.14. Returns once the remote task is terminal; throws on payment, transport or timeout failures. */
  async call(key: AuthedApiKey, targetEntityId: string, req: CallInput): Promise<OutboundResult> {
    const maxMicro = parseUsd((req.maxPaymentUsd ?? this.deps.defaultMaxPaymentUsd) as string | number, 'maxPaymentUsd');
    const payFrom = await this.payingListing(key.developerId, req.payFromListingId);

    let entity;
    try {
      entity = await this.deps.agentDns.getEntity(targetEntityId);
    } catch (err) {
      if (err instanceof AgentDnsError) throw new ApiError('GATEWAY_UNAVAILABLE', 'AgentDNS lookup failed');
      throw err;
    }
    if (!entity) throw new ApiError('NOT_FOUND', 'Agent not found');
    const endpoint = a2aEndpoint(entity.entity_url);

    const task = await this.deps.tasks.create({ developerId: key.developerId, apiKeyId: key.id, direction: 'OUTBOUND', input: req.input ?? null });
    const deadline = Date.now() + (this.deps.timeoutMs ?? 300_000);
    // What every payment line for this call says about who is paying whom.
    const who = {
      target: `agent:${targetEntityId}`,
      wallet: payFrom ? `listing:${String(req.payFromListingId)}` : 'developer',
      listing: payFrom ? String(req.payFromListingId) : undefined,
      task: task.id,
    };
    let reserved = 0n;
    let paymentTxn: string | null = null;
    let paymentUsd: string | null = null;

    const fail = async (to: 'FAILED' | 'TIMEOUT', error: string): Promise<void> => {
      await this.deps.tasks.transition(task.id, ['PENDING', 'PROCESSING'], to, { error });
    };

    try {
      await this.deps.tasks.transition(task.id, ['PENDING'], 'PROCESSING');

      // First attempt, unpaid.
      const message = outboundMessage(req.input);
      await this.deps.identity.withDeveloperKeypair(key.developerId, (dev) => signZyndAuth(message, dev));
      let reply = await this.rpc(endpoint, 'message/send', { message }, {}, deadline);

      if (reply.status === 402) {
        const requirements = this.deps.payments.parsePaymentRequired(headersOf(reply.headers), reply.json);
        const decimals = Number(isObj(requirements.extra) && typeof requirements.extra.decimals === 'number' ? requirements.extra.decimals : 6);
        const micro = atomicToMicroUsd(BigInt(requirements.amount), decimals);
        if (micro > maxMicro) {
          logPayment(this.log, 'warn', 'payment cap refused', { cap: 'maxPaymentUsd', requiredUsd: usd(micro), maxPaymentUsd: usd(maxMicro), ...who });
          throw new ApiError('PAYMENT_CAP', `Agent asks for $${formatUsd(micro)}, above maxPaymentUsd $${formatUsd(maxMicro)}`, { requiredUsd: formatUsd(micro), maxPaymentUsd: formatUsd(maxMicro) });
        }
        // M2.16: reserve before signing. The conditional UPDATE is the only place the cap is checked.
        if (!(await this.deps.apiKeys.reserveSpend(key.id, micro))) {
          logPayment(this.log, 'warn', 'payment cap refused', { cap: 'keySpend', requiredUsd: usd(micro), key: key.id, ...who });
          throw new ApiError('PAYMENT_CAP', 'This payment would exceed the API key spend cap', { requiredUsd: formatUsd(micro) });
        }
        reserved = micro;
        paymentUsd = formatUsd(micro);
        await this.deps.tasks.setPayment(task.id, { paymentUsd });

        const paidMessage = outboundMessage(req.input);
        const paid = await this.deps.identity.withDeveloperKeypair(key.developerId, (dev) => {
          signZyndAuth(paidMessage, dev); // fresh nonce: the first one was spent on the unpaid attempt
          return this.deps.payments.signX402((payFrom ?? dev).privateKey, requirements);
        });
        // A transport error here keeps the reservation: nothing proves the payment was not received,
        // and over-counting spend is the safe direction for a cap.
        reply = await this.rpc(endpoint, 'message/send', { message: paidMessage }, paid.headers, deadline);
        const settlement = this.deps.payments.parsePaymentResponse(headersOf(reply.headers));
        if (settlement?.success && settlement.transaction) paymentTxn = settlement.transaction;

        // The agent refused the paid request and reported no settlement: nothing was charged.
        const refused = reply.status >= 400 || (isObj(reply.json) && isObj(reply.json.error));
        if (refused && !paymentTxn) {
          logPayment(this.log, 'warn', reply.status === 402 ? 'payment rejected by agent' : 'payment not taken by agent', {
            reason: reasonFromBody(reply.json),
            status: reply.status,
            amountUsd: usd(micro),
            payer: paid.payer,
            ...who,
          });
          await this.deps.apiKeys.refundSpend(key.id, reserved);
          reserved = 0n;
          paymentUsd = null;
          if (reply.status === 402) throw new ApiError('PAYMENT_FAILED', 'Agent rejected the payment');
        } else {
          logPayment(this.log, 'info', 'payment paid', { amountUsd: usd(micro), tx: paymentTxn ?? 'none', payer: paid.payer, ...who });
        }
      }

      const result = this.unwrap(reply);
      const final = await this.resolve(endpoint, result, deadline);
      const row = await this.deps.tasks.transition(
        task.id,
        ['PROCESSING'],
        final.failed ? 'FAILED' : 'COMPLETED',
        { output: final.output ?? null, error: final.error, paymentTxn, paymentUsd },
      );
      const finished = row ?? ((await this.deps.tasks.get(task.id)) as TaskRow);
      return view(finished);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TASK_TIMEOUT') await fail('TIMEOUT', err.message);
      else await fail('FAILED', err instanceof ApiError ? err.message : 'Call failed');
      throw err;
    }
  }

  /** M2.15: a task this API key started. Other keys' tasks look like they do not exist. */
  async getTask(key: AuthedApiKey, taskId: string): Promise<OutboundResult> {
    const row = await this.deps.tasks.get(taskId);
    if (!row || row.apiKeyId !== key.id) throw new ApiError('NOT_FOUND', 'Task not found');
    return view(row);
  }

  // --- internals -----------------------------------------------------------------------------

  /** The keypair of the listing that pays, or undefined for the developer wallet. Checked before any task is created. */
  private async payingListing(developerId: string, raw: unknown): Promise<Ed25519Keypair | undefined> {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') throw new ApiError('BAD_REQUEST', 'payFromListingId must be a string');
    const owned = this.deps.store ? await this.deps.store.getOwned(developerId, raw) : undefined;
    if (!owned) throw new ApiError('NOT_FOUND', 'payFromListingId is not one of your listings');
    const l = owned.listing;
    return this.deps.identity.getListingKeypair({ listingId: l.id, developerId: l.developerId, derivedKeyIndex: l.derivedKeyIndex });
  }

  private async rpc(url: string, method: string, params: unknown, extraHeaders: Record<string, string>, deadline: number): Promise<RpcReply> {
    const left = deadline - Date.now();
    if (left <= 0) throw new ApiError('TASK_TIMEOUT');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(left),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new ApiError('TASK_TIMEOUT');
      throw new ApiError('GATEWAY_UNAVAILABLE', 'Could not reach the agent', { reason: (err as Error).message });
    }
    const json = (await res.json().catch(() => undefined)) as unknown;
    return { status: res.status, headers: res.headers, json };
  }

  /** The JSON-RPC `result` of a reply, or a typed error. */
  private unwrap(reply: RpcReply): Record<string, unknown> {
    const body = reply.json;
    if (isObj(body) && isObj(body.error)) {
      const msg = typeof body.error.message === 'string' ? body.error.message : 'Agent returned an error';
      throw new ApiError('GATEWAY_UNAVAILABLE', `Agent rejected the call: ${msg}`, { agentCode: body.error.code });
    }
    if (reply.status >= 400) throw new ApiError('GATEWAY_UNAVAILABLE', `Agent answered HTTP ${reply.status}`, { status: reply.status });
    if (!isObj(body) || !isObj(body.result)) throw new ApiError('GATEWAY_UNAVAILABLE', 'Agent sent an unreadable response');
    return body.result;
  }

  /** Turn a Task or Message result into a final outcome, polling tasks/get while the task is open. */
  private async resolve(endpoint: string, result: Record<string, unknown>, deadline: number): Promise<{ failed: boolean; output: unknown; error: string | null }> {
    // A direct Message reply is a complete synchronous answer.
    if (result.kind === 'message' || (Array.isArray(result.parts) && !isObj(result.status))) {
      return { failed: false, output: deriveInput(result as A2AMessage), error: null };
    }
    let task = result;
    const interval = this.deps.pollIntervalMs ?? 2_000;
    for (;;) {
      const status = isObj(task.status) ? task.status : {};
      const state = typeof status.state === 'string' ? status.state : 'unknown';
      if (TERMINAL.has(state)) return outcome(task, state);
      if (typeof task.id !== 'string') throw new ApiError('GATEWAY_UNAVAILABLE', 'Agent sent a task without an id');
      if (Date.now() + interval > deadline) throw new ApiError('TASK_TIMEOUT');
      await sleep(interval);
      task = this.unwrap(await this.rpc(endpoint, 'tasks/get', { id: task.id }, {}, deadline));
    }
  }
}

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function outcome(task: Record<string, unknown>, state: string): { failed: boolean; output: unknown; error: string | null } {
  if (state === 'completed') {
    const artifacts = Array.isArray(task.artifacts) ? (task.artifacts as { parts?: unknown[] }[]) : [];
    const parts = artifacts.flatMap((a) => (Array.isArray(a.parts) ? a.parts : []));
    const status = isObj(task.status) ? task.status : {};
    const fallback = isObj(status.message) && Array.isArray(status.message.parts) ? status.message.parts : [];
    return { failed: false, output: deriveInput({ parts: parts.length ? parts : fallback }), error: null };
  }
  const status = isObj(task.status) ? task.status : {};
  const parts = isObj(status.message) && Array.isArray(status.message.parts) ? (status.message.parts as { text?: string }[]) : [];
  const text = parts.map((p) => p.text).filter(Boolean).join('\n');
  return { failed: true, output: null, error: text || `Agent task ${state}` };
}

function view(row: TaskRow): OutboundResult {
  return {
    taskId: row.id,
    status: row.status,
    output: row.output ?? null,
    error: row.error ?? null,
    paymentUsd: row.paymentUsd ?? null,
    paymentTxn: row.paymentTxn ?? null,
  };
}

