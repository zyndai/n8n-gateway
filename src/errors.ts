/**
 * Error catalogue (LLD > Error Handling). Every Gateway error serialises to
 * `{ error, code, details? }`. The n8n node maps any non-2xx to NodeApiError.
 */
export const ERROR_CATALOGUE = {
  AUTH_INVALID: { status: 401, message: 'Invalid API key' },
  AUTH_EXPIRED: { status: 401, message: 'API key expired' },
  AUTH_FORBIDDEN: { status: 403, message: 'Permission denied' },
  PAYMENT_CAP: { status: 402, message: 'Spend cap exceeded' },
  PAYMENT_FAILED: { status: 402, message: 'Payment failed' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  LISTING_INACTIVE: { status: 409, message: 'Listing is not active' },
  TASK_TIMEOUT: { status: 504, message: 'Task timed out after 300 s' },
  // M5.2 (G11): per-API-key rate limit on /n8n/v1/*; `Retry-After` carries the wait.
  RATE_LIMITED: { status: 429, message: 'Rate limit exceeded' },
  // Not in the LLD table (which lists 502 with no code); added so every
  // response, including 502, carries a machine-readable code.
  GATEWAY_UNAVAILABLE: { status: 502, message: 'Gateway unavailable' },
  // Generic codes outside the LLD table.
  BAD_REQUEST: { status: 400, message: 'Bad request' },
  CONFLICT: { status: 409, message: 'Conflict' },
  NOT_IMPLEMENTED: { status: 501, message: 'Not implemented' },
  INTERNAL: { status: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CATALOGUE[code].message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CATALOGUE[code].status;
    this.details = details;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: this.message, code: this.code };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}
