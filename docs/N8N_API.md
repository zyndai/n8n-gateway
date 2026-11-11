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
| `POST /airnode/call` | call | Call an AirnodeHub operation; the Gateway pays its x402 402 in aUSD and verifies the signed answer |
| `POST /airnode/verify` | search | Re-check a kept AirnodeHub attestation. Free |

## Call an agent

`input` may be any JSON; a string is sent as a text part, anything else as a data part. `payFromListingId` (optional, one of the key's listings) pays from that listing's wallet instead of the developer wallet; `x-zynd-auth` is still signed by the developer. An agent can then spend what it earns. `maxPaymentUsd` (decimal, at most 6 decimals) caps this one call; default `X402_DEFAULT_MAX_PAYMENT_USD` (0.10).

```json
{ "taskId": "…", "status": "COMPLETED", "output": { "answer": 42 }, "error": null, "paymentUsd": "0.050000", "paymentTxn": "0x…" }
```

`status` is `COMPLETED` or `FAILED` (the agent ran and failed: HTTP 200 with `error`). Transport and policy problems are HTTP errors: `402 PAYMENT_CAP` (price above `maxPaymentUsd`, or the key's spend cap would be exceeded), `402 PAYMENT_FAILED`, `404 NOT_FOUND` (unknown agent), `502 GATEWAY_UNAVAILABLE`, `504 TASK_TIMEOUT`.

## AirnodeHub (Zynd x AirnodeHub showcase)

n8n cannot sign x402, so the Gateway makes AirnodeHub calls for a workflow. Node: **Zynd AirnodeHub**.

`POST /airnode/call` body `{ listingUrl, operation, parameters?, maxPaymentUsd?, payFromListingId? }`:

- `listingUrl` must be an allow-listed listing root (`AIRNODE_HOST_PATTERN`, default `^airnode-[a-z0-9-]+\.fly\.dev$`, https, no path). Anything else is `400`.
- A priced operation answers 402. The Gateway pays only `AIRNODE_ASSET` on `AIRNODE_NETWORK` (aUSD on Base Sepolia), only up to `maxPaymentUsd` (default `AIRNODE_DEFAULT_MAX_PAYMENT_USD`, 0.05), reserved on the API key's spend cap like an agent call. It pays from the developer wallet, or from the wallet of `payFromListingId` (one of the key's listings), so an agent can spend what it earns.
- The answer is checked: the request hash must match `operation` + `parameters`, and the EIP-191 signer of `keccak256(requestHash ‖ uint256 timestamp ‖ utf8(data))` must equal the `x-airnode.address` the listing publishes (read from `GET listingUrl`, cached 10 min), never the envelope's own `airnode` field.

```json
{ "listingUrl": "https://airnode-gleif.fly.dev/", "operation": "getLegalEntity", "parameters": { "lei": "…" },
  "data": { "…": "parsed upstream body" },
  "attestation": { "airnode": "0x…", "requestHash": "0x…", "timestamp": "1794388576", "data": "<exact signed string>", "signature": "0x…" },
  "verification": { "verified": true, "signer": "0x…", "expectedSigner": "0x…", "requestHashMatches": true },
  "payment": { "amountUsd": "0.010000", "transaction": "0x…", "payer": "0x…" },
  "signedAt": "2026-11-11T08:52:56.000Z" }
```

`payment` is `null` for a free operation. Keep `attestation` (with `operation` and `parameters`) to prove later what the agent saw: `POST /airnode/verify` with `{ listingUrl, operation, parameters, attestation }` returns the same `verification` shape. Errors: `400` (bad URL, operation or parameters, or the Airnode rejected the parameters: nothing charged), `402 PAYMENT_CAP` (price above the cap, or the key's spend cap), `402 PAYMENT_FAILED` (a token other than the configured one, or the Airnode rejected the payment), `404` (no such operation, or `payFromListingId` is not yours), `502` (the Airnode failed: nothing charged).

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
