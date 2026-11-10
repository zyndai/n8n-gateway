// `/a/:entityId/a2a/v1` for other agents: A2A JSON-RPC + x402 (M2.9, M2.10, M2.12).
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { ApiError } from '../errors.js';
import { SEND_METHODS, createA2aAuth } from '../middleware/a2aAuth.js';
import { PaymentRequiredError, type A2AHandler } from '../services/A2AHandler.js';
import type { NonceStoreLike } from '../services/NonceStore.js';
import { ZyndAuthError, type A2AMessage } from '../services/zyndAuth.js';

export interface A2aDeps {
  a2a: () => A2AHandler;
  nonces: () => NonceStoreLike;
}

const RPC = { METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, SERVER: -32000, TASK_NOT_FOUND: -32001, NOT_CANCELABLE: -32002 };

type RpcId = string | number | null;

function rpcCodeFor(err: ApiError): number {
  if (err instanceof ZyndAuthError) return err.rpcCode;
  switch (err.code) {
    case 'NOT_FOUND':
      return RPC.TASK_NOT_FOUND;
    case 'CONFLICT':
      return RPC.NOT_CANCELABLE;
    case 'BAD_REQUEST':
      return RPC.INVALID_PARAMS;
    case 'INTERNAL':
      return RPC.INTERNAL;
    default:
      return RPC.SERVER;
  }
}

const idOf = (req: Request): RpcId => {
  const id = (req.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
};

function sendError(res: Response, id: RpcId, err: ApiError, httpStatus = err.status, rpcCode = rpcCodeFor(err)): void {
  if (err instanceof PaymentRequiredError) res.setHeader('PAYMENT-REQUIRED', err.paymentRequiredHeader);
  res.status(httpStatus).json({
    jsonrpc: '2.0',
    id,
    error: { code: rpcCode, message: err.message, data: { code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) } },
  });
}

export function createA2aRouter(deps: A2aDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(createA2aAuth(deps.nonces));

  router.post('/', async (req, res) => {
    const entityId = (req.params as Record<string, string>).entityId as string;
    const body = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | undefined;
    const id = idOf(req);
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return sendError(res, id, new ApiError('BAD_REQUEST', 'Not a valid JSON-RPC 2.0 request'), 400);
    }
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
    const handler = deps.a2a();

    if (SEND_METHODS.has(body.method)) {
      const message = params.message;
      if (!message || typeof message !== 'object' || Array.isArray(message) || !Array.isArray((message as A2AMessage).parts)) {
        return sendError(res, id, new ApiError('BAD_REQUEST', 'params.message with parts is required'), 400);
      }
      if (!req.zyndCaller) throw new ApiError('AUTH_INVALID', 'x-zynd-auth is required');
      const sent = await handler.tasksSend(entityId, message as A2AMessage, req.zyndCaller, req.headers);
      if (sent.paymentResponse) res.setHeader('PAYMENT-RESPONSE', sent.paymentResponse);
      return void res.json({ jsonrpc: '2.0', id, result: sent.task });
    }

    if (body.method === 'tasks/get' || body.method === 'tasks/cancel') {
      if (typeof params.id !== 'string' || !params.id) return sendError(res, id, new ApiError('BAD_REQUEST', 'params.id is required'), 400);
      const task = body.method === 'tasks/get' ? await handler.tasksGet(entityId, params.id) : await handler.tasksCancel(entityId, params.id);
      return void res.json({ jsonrpc: '2.0', id, result: task });
    }

    return sendError(res, id, new ApiError('BAD_REQUEST', `Method not found: ${body.method}`), 404, RPC.METHOD_NOT_FOUND);
  });

  // Render every failure on this router as a JSON-RPC error envelope (HTTP status kept: 401/402/409/504...).
  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) return sendError(res, idOf(req), err);
    console.error('Unhandled A2A error', err);
    sendError(res, idOf(req), new ApiError('INTERNAL'));
  };
  router.use(onError);
  return router;
}
