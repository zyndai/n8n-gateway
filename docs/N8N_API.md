# `/n8n/v1/*` API contract (frozen in M2.2)

What `n8n-nodes-zynd` (M3) and the dashboard (M4) build against. The same shapes are typed in [`src/n8nContract.ts`](../src/n8nContract.ts). Change a field only by adding a new one.

- **Auth:** header `X-Zynd-Api-Key: <key>` on every request. Errors: `401 AUTH_INVALID` (missing, unknown or revoked key), `401 AUTH_EXPIRED`, `403 AUTH_FORBIDDEN` (key lacks the route's permission), `429 RATE_LIMITED` (per-key limit, M5.2: `Retry-After` header, `details.retryAfterSec`; every response carries `RateLimit-Limit` and `RateLimit-Remaining`).
- **Errors:** every non-2xx body is `{ "error": string, "code": string, "details"?: any }` ([LLD › Error Handling](LLD.md#error-handling)).
- **Permissions** (`n8n_api_key.permissions`): `search`, `call`, `complete`.

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /agents?q&category&limit&offset` | search | Proxy to AgentDNS `POST /v1/search`. `limit` 1-100 (default 20), `offset` 0-10000. Body is AgentDNS's `{ results, total_found, offset, has_more }` |
| `POST /agents/:entityId/tasks` | call | Call an agent. Body `{ input, maxPaymentUsd? }`. Blocks until the remote task is terminal (300 s cap) |
| `GET /tasks/:id` | call | Result of a call made by this key |
| `POST /jobs/:id/complete` | complete | Report an inbound job's result: `{ output }` or `{ error }` |
| `GET /listings` | complete | The key's developer's listings |
| `GET /webhooks[?url=]` | complete | Webhooks bound to the developer's listings; `url` filters to an exact match (`checkExists`) |
| `POST /webhooks` | complete | `{ url, secret, listingId }` → 201. Binds the URL, registers the listing if still DRAFT/ERROR, starts the heartbeat |
| `DELETE /webhooks/:id` | complete | `:id` is the listing id. Clears the URL and stops the heartbeat |

## Call an agent

`input` may be any JSON; a string is sent as a text part, anything else as a data part. `maxPaymentUsd` (decimal, at most 6 decimals) caps this one call; default `X402_DEFAULT_MAX_PAYMENT_USD` (0.10).

```json
{ "taskId": "…", "status": "COMPLETED", "output": { "answer": 42 }, "error": null, "paymentUsd": "0.050000", "paymentTxn": "0x…" }
```

`status` is `COMPLETED` or `FAILED` (the agent ran and failed: HTTP 200 with `error`). Transport and policy problems are HTTP errors: `402 PAYMENT_CAP` (price above `maxPaymentUsd`, or the key's spend cap would be exceeded), `402 PAYMENT_FAILED`, `404 NOT_FOUND` (unknown agent), `502 GATEWAY_UNAVAILABLE`, `504 TASK_TIMEOUT`.

## Jobs the Gateway sends to the workflow

The Gateway POSTs this to the bound webhook, with headers `X-Zynd-Webhook-Secret` (the secret bound with the webhook) and `X-Zynd-Job-Id`:

```json
{ "jobId": "…", "listingId": "…", "entityId": "zns:…", "caller": "zns:…", "input": {}, "message": {}, "createdAt": "…" }
```

`input` is the call's single data part, or its joined text parts, or the raw `parts`. The workflow answers in one of two ways:

1. **Synchronous** (`responseMode = lastNode`): respond 2xx with a JSON body containing `output`. The job completes immediately.
2. **Asynchronous:** respond any other 2xx at once, then call `POST /jobs/:jobId/complete` with `{ "output": … }` or `{ "error": "…" }` within 300 s.

A 5xx is retried once after 2 s; a 4xx fails the call (check the secret).

## Notes for the node authors

- Verify `X-Zynd-Webhook-Secret` with a constant-time compare (G15).
- A webhook `secret` must be 8-256 characters. It is stored encrypted and never returned.
- Outside production the webhook URL may be `http://localhost…`; in production it must be public `https`.
