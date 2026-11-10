// LLD > WebhookForwarder (M2.8): POST a job to the n8n webhook with the shared secret.
// Retries once after 2 s on a 5xx or a failed connection; 10 s to connect, 30 s for the response.
// Uses node:http(s) rather than fetch because fetch cannot time the connect phase separately.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ApiError } from '../errors.js';

export interface ForwardPayload {
  /** The Gateway's task id; the workflow passes it back to `POST /n8n/v1/jobs/:id/complete`. */
  jobId: string;
  listingId: string;
  entityId: string;
  /** Entity id of the calling agent. */
  caller: string;
  /** The call's payload: the single data part, the joined text parts, or the raw `parts`. */
  input: unknown;
  /** The full A2A message (without the caller's auth block). */
  message: unknown;
  createdAt: string;
}

export interface ForwardResult {
  status: number;
  /** Parsed JSON response body, if it was JSON. */
  body: unknown;
}

export interface WebhookForwarderOptions {
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  retryDelayMs?: number;
  /** Largest response body kept; the rest is dropped. */
  maxBodyBytes?: number;
}

class Transient extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WebhookForwarder {
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxBodyBytes: number;

  constructor(opts: WebhookForwarderOptions = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? 30_000;
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  }

  /**
   * Resolves with the webhook's response on any 2xx. Throws `GATEWAY_UNAVAILABLE` if the webhook
   * is unreachable, answers 5xx twice, answers 4xx (a retry would not help), or times out.
   * A response timeout is not retried: the workflow may already be running the job.
   */
  async forward(webhookUrl: string, secret: string, payload: ForwardPayload): Promise<ForwardResult> {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new ApiError('GATEWAY_UNAVAILABLE', 'Webhook URL is invalid');
    }
    const body = JSON.stringify(payload);
    try {
      return await this.attempt(url, secret, body, payload.jobId);
    } catch (err) {
      if (!(err instanceof Transient)) throw err;
      await sleep(this.retryDelayMs);
      try {
        return await this.attempt(url, secret, body, payload.jobId);
      } catch (err2) {
        if (err2 instanceof Transient) throw new ApiError('GATEWAY_UNAVAILABLE', 'n8n webhook is unavailable', { reason: err2.message });
        throw err2;
      }
    }
  }

  private attempt(url: URL, secret: string, body: string, jobId: string): Promise<ForwardResult> {
    const https = url.protocol === 'https:';
    if (!https && url.protocol !== 'http:') return Promise.reject(new ApiError('GATEWAY_UNAVAILABLE', 'Webhook URL must be http(s)'));

    return new Promise<ForwardResult>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        fn();
      };

      const req = (https ? httpsRequest : httpRequest)(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Zynd-Webhook-Secret': secret,
            'X-Zynd-Job-Id': jobId,
            Connection: 'close',
          },
          agent: false,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            if (size < this.maxBodyBytes) chunks.push(c);
            size += c.length;
          });
          res.on('error', (e) => done(() => reject(new Transient(e.message))));
          res.on('end', () =>
            done(() => {
              const status = res.statusCode ?? 0;
              if (status >= 500) return reject(new Transient(`webhook answered ${status}`));
              if (status < 200 || status >= 300) {
                return reject(new ApiError('GATEWAY_UNAVAILABLE', `n8n webhook rejected the job (HTTP ${status})`, { status }));
              }
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown;
              try {
                parsed = text ? (JSON.parse(text) as unknown) : undefined;
              } catch {
                parsed = undefined;
              }
              resolve({ status, body: parsed });
            }),
          );
        },
      );

      const connectTimer = setTimeout(() => {
        req.destroy();
        done(() => reject(new Transient('connect timeout')));
      }, this.connectTimeoutMs);
      req.on('socket', (socket) => {
        if (!socket.connecting) return clearTimeout(connectTimer);
        socket.once(https ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
      });
      const responseTimer = setTimeout(() => {
        req.destroy();
        done(() => reject(new ApiError('GATEWAY_UNAVAILABLE', 'n8n webhook did not respond in time', { timeoutMs: this.responseTimeoutMs })));
      }, this.responseTimeoutMs);
      req.on('error', (e) => done(() => reject(new Transient(e.message))));
      req.end(body);
    });
  }
}
