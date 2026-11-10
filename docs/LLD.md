# Zynd n8n Integration — Low-Level Design

## n8n Package — `n8n-nodes-zynd`

### File Layout

| File | Purpose |
| --- | --- |
| `credentials/ZyndApi.credentials.ts` | API URL, API key, webhook secret |
| `nodes/Zynd/Zynd.node.ts` | Action node: search, call, complete, list |
| `nodes/Zynd/ZyndTrigger.node.ts` | Trigger node: receives inbound paid jobs |
| `nodes/Zynd/zynd.svg` | Node icon |
| `.github/workflows/ci.yml` | Lint + build on PR |
| `.github/workflows/publish.yml` | `npm publish --provenance` on version tag |

`package.json` declares `n8n-community-node-package` keyword, `peerDependencies` on `n8n-workflow`, zero `dependencies`. Build with `tsc` only — no bundler needed.

### ZyndApi Credential

| Field | Type | Default |
| --- | --- | --- |
| `apiUrl` | string | `https://gw.zynd.ai` |
| `apiKey` | password | — |
| `webhookSecret` | password | — |

### Zynd Node — Action

| Operation | HTTP | Path | Key Parameters |
| --- | --- | --- | --- |
| Search agents | GET | `/n8n/v1/agents` | `q`, `category`, `limit`, `offset` |
| Call agent | POST | `/n8n/v1/agents/:id/tasks` | `input`, `maxPaymentUsd?` |
| Get task | GET | `/n8n/v1/tasks/:id` | — |
| Complete job | POST | `/n8n/v1/jobs/:id/complete` | `output` |
| List listings | GET | `/n8n/v1/listings` | — |

`usableAsTool = true` so n8n's built-in AI agent can discover and invoke it. All HTTP calls go through `this.helpers.httpRequestWithAuthentication('zyndApi', opts)`.

### ZyndTrigger Node

| webhookMethod | Calls |
| --- | --- |
| `checkExists` | `GET /n8n/v1/webhooks?url={webhookUrl}` |
| `create` | `POST /n8n/v1/webhooks` with `{ url, secret, listingId }` |
| `delete` | `DELETE /n8n/v1/webhooks/:id` |

Option `responseMode = 'lastNode'`: enables synchronous paid-call flows where the caller blocks until the result is ready.

---

## Gateway — `zynd-n8n-gateway`

### Module Layout

| Directory | Key Files | Purpose |
| --- | --- | --- |
| `src/routes/` | `n8n.ts`, `a2a.ts`, `dashboard.ts` | Route handlers for three audiences |
| `src/middleware/` | `apiKeyAuth.ts`, `sessionAuth.ts`, `a2aAuth.ts` | Auth per audience |
| `src/services/` | See below | Core business logic |
| `src/db/` | `schema.ts`, `dashboard.ts`, `client.ts`, `migrations/` | Database layer (Drizzle) |

Express app. Key dependencies: `@noble/curves`, `@noble/hashes`, `ws`, `drizzle-orm`, `postgres` (postgres.js), `express`. Built with esbuild into one minified file (`dist/index.mjs`) to keep memory low; `tsc` is used for type checking only.

### IdentityService

| Method | Input | Output |
| --- | --- | --- |
| `deriveKeypair` | dev private-key bytes, derivation index | Ed25519 keypair |
| `signRegistration` | keypair, entity data | canonical JSON + signature |
| `signHeartbeat` | keypair | RFC 3339 timestamp + signature |
| `createDerivationProof` | dev keypair, agent keypair, index | proof for AgentDNS |

Reads encrypted developer keys from the dashboard's `developer_keys` table (`private_key_enc`). Decrypts with AES-256-GCM using the same path as the dashboard (`decryptPrivateKey`): `base64(iv[12] ‖ authTag[16] ‖ ciphertext)` under `PKI_ENCRYPTION_KEY`; the plaintext is the base64 of the Ed25519 private key (32-byte seed, or 64-byte seed‖public, of which the Gateway uses the first 32 bytes). The decrypted key is checked against the stored `public_key` and zeroed after use.

Wire formats (byte-compatible with the TS SDK and AgentDNS, verified against both):

| Operation | Definition |
| --- | --- |
| `deriveKeypair` | `seed = SHA-512(devSeed ‖ "zns:agent:" ‖ uint32_be(index))[:32]`, then Ed25519 from seed |
| entity id | `"zns:" + hex(SHA-256(agentPublicKey)[:16])`. Known before registration, so `entity_url` can be set in the same request |
| `signRegistration` | Canonical JSON (sorted keys, no whitespace) of `{category, entity_url, name, public_key, summary, tags}` (+ `entity_type` only if set), signed as `ed25519:<base64>` |
| `createDerivationProof` | `{ developer_public_key, entity_index, developer_signature }`, where the signature is over `agentPublicKey ‖ uint32_be(index)` |
| `signHeartbeat` | Signature over the UTF-8 bytes of an RFC 3339 timestamp (second precision), sent as `{ timestamp, signature }` |

Derived keypairs are cached per listing (`getListingKeypair`), so only the first call decrypts. The developer master key is never cached. `invalidate(listingId)` runs on deactivation and `invalidateDeveloper(developerId)` is for key rotation.

### HeartbeatManager

Maintains a `Map<entityId, WebSocket>`. Each active listing holds one persistent connection to AgentDNS.

- **`start({ listingId, entityId, keypair })`** — Opens WebSocket to `GET /v1/entities/{id}/ws`. Sends a signed `{timestamp, signature}` frame immediately and then every 30 s. Idempotent.
- **`stop(entityId)`** — Closes WebSocket, sets status STOPPED, removes from map. Returns once the row is written.
- **Reconnect** — Exponential backoff 1 s → 2 s → 4 s → 8 s → 16 s → max 30 s. The 5th consecutive failure sets status FAILED; retries then continue at the cap, and the first successful beat sets the status back to ACTIVE. The failure counter resets once a connection survives a second beat.
- **Liveness** — Every beat is accompanied by a WebSocket ping. A missing pong at the next beat counts as a failure (detects half-open connections).
- **Startup recovery** — On process start, `resumeActive()` queries all ACTIVE listings (that have a webhook bound, see G7) and resumes heartbeats. A listing that cannot be resumed is marked FAILED without blocking the others.
- **Persistence** — `N8nHeartbeat` writes are serialised per listing, so a late ACTIVE can never overwrite STOPPED. Process shutdown closes sockets without writing STOPPED, so listings resume on the next boot.

**When a listing beats (G7).** Activation registers the agent on AgentDNS and sets the listing ACTIVE. The heartbeat starts only once the listing also has a `webhookUrl` (set by ZyndTrigger in M2.5), so an agent is never advertised as live while it cannot receive jobs. Set `HEARTBEAT_REQUIRES_WEBHOOK=false` to beat as soon as the listing is registered.

### A2AHandler

Mounted at `POST /a/:entityId/a2a/v1` (JSON-RPC 2.0). Methods: `tasks/send` (alias `message/send`), `tasks/get`, `tasks/cancel`. Failures keep their HTTP status (401, 402, 409, 504) and carry a JSON-RPC error envelope; auth errors use the SDK codes -32100 / -32101 / -32102.

Discovery: `GET /a/:entityId/.well-known/agent-card.json` serves the listing's A2A Agent Card (protocol 0.3.0, `preferredTransport: JSONRPC`, `url` = `{entity_url}/a2a/v1`). SDK clients append that path to the registry's `entity_url`. The card is signed by the listing key (detached JWS over the JCS body, as the SDK's `signAgentCard`) and its `x-zynd` block carries the entity id, public key, derivation proof, wallet address and pricing. It declares no streaming or push support.

Flow for `tasks/send`:

1. `a2aAuth` middleware: verify `params.message.metadata["x-zynd-auth"]` (see below), claim the nonce
2. Look up the listing by `entityId`; it must be ACTIVE with a webhook bound, else `LISTING_INACTIVE` (409)
3. If the listing has a price (its own `priceUsd`, else `X402_INBOUND_PRICE_USD`; `0` = free), `PaymentProcessor.verifyX402`; a missing or invalid proof answers 402 with a `PAYMENT-REQUIRED` header
4. Create `N8nTask` (INBOUND, PENDING; the caller's auth block is not stored)
5. `WebhookForwarder.forward(webhookUrl, secret, job)`; PENDING → PROCESSING. A 2xx body containing `output` finishes the job here
6. Wait until COMPLETED / FAILED / CANCELED, woken the moment `jobs/complete` lands and polling every 2 s as a fallback; after 300 s set TIMEOUT and answer `TASK_TIMEOUT` (504)
7. If a payment was verified and the job COMPLETED, settle it (`PAYMENT-RESPONSE` header, `paymentTxn` stored); otherwise release it. Answer with an A2A `Task` (output in an artifact: a text part for strings, a data part otherwise)

`x-zynd-auth` (`zyndAuth.ts`, wire format of the TS SDK): `{ v: 1, entity_id, public_key, nonce, issued_at, expires_at, signature, fqan?, developer_proof? }`. The signature is Ed25519 over `"ZYND-A2A-MSG-v1\n" ‖ JCS(message)` with `signature` blanked. Checks, in order: version, timestamps (60 s skew, lifetime at most 10 min), `entity_id` matches the key, signature, then the nonce is claimed in `n8n_nonce` (key `entity_id:nonce`). `developer_proof` is accepted but not verified.

`tasks/get` and `tasks/cancel` take `{ id }`; the task must belong to the entity in the URL. Cancel ends the A2A task only (the Gateway cannot stop an n8n execution): status CANCELED, payment released, a later `jobs/complete` answers 409.

### PaymentProcessor

x402 v2, `exact` scheme, EVM, EIP-3009 `TransferWithAuthorization`. Built on `@noble` only.

| Method | Purpose |
| --- | --- |
| `verifyX402(headers, requirements)` | Verify an inbound `PAYMENT-SIGNATURE`: structure, amount and recipient equal to `requirements`, validity window, signer recovered from the EIP-712 signature, in-process nonce replay guard, then facilitator `/verify` |
| `settle(verified)` / `release(verified)` | Facilitator `/settle` after a successful job / free the authorization when the job did not succeed |
| `requirementsFor(payTo, usd)` / `paymentRequiredHeader(...)` | Build what an inbound caller must pay (`payTo` is the listing's own EVM address) |
| `signX402(devPrivateKeyBytes, requirements)` | Create the `PAYMENT-SIGNATURE` header for an outbound call, signed by the developer's EVM key |
| `parsePaymentRequired(headers, body)` / `parsePaymentResponse(headers)` | Read a target's 402 and its settlement header |
| `deriveEvmKey(ed25519PrivateKey)` / `evmAddress(...)` | `SHA-256(Ed25519 seed)` as the secp256k1 key; EIP-55 address |

Configuration: `X402_FACILITATOR_URL`, `X402_NETWORK`, `X402_ASSET` (+ `_NAME`, `_VERSION`, `_DECIMALS`), `X402_INBOUND_PRICE_USD`, `X402_DEFAULT_MAX_PAYMENT_USD`. Amounts are decimal USD strings (6 decimals) converted with `bigint`, never floats.

### AgentCaller (outbound, flow 2)

`POST /n8n/v1/agents/:id/tasks`: look up `entity_url` on AgentDNS, send `message/send` to `{entity_url}/a2a/v1` signed with the developer master key (G3). On a 402: check the price against `maxPaymentUsd` (default `X402_DEFAULT_MAX_PAYMENT_USD`), reserve it on the API key with one conditional `UPDATE` (`PAYMENT_CAP` if it exceeds `spendCapUsd`), sign, and send again with `PAYMENT-SIGNATURE` and a fresh `x-zynd-auth`. Then follow the returned task with `tasks/get` every 2 s (300 s cap). The reservation is refunded only when the agent refused the paid request and reported no settlement.

### WebhookForwarder

POSTs the job to the n8n webhook with `X-Zynd-Webhook-Secret` and `X-Zynd-Job-Id` headers. Retry once after 2 s on 5xx or a failed connection. Connection timeout 10 s, response timeout 30 s (a response timeout and a 4xx are not retried; redirects are not followed). Body: see `WebhookJob` in `src/n8nContract.ts`.

---

## Dashboard — n8n Panel

### Pages

| Path | Component | Purpose |
| --- | --- | --- |
| `/dashboard/n8n` | `N8nOverview` | Active listings, key count, recent tasks |
| `/dashboard/n8n/listings` | `N8nListings` | Table with status badges, activate/deactivate |
| `/dashboard/n8n/listings/new` | `N8nListingForm` | Name, summary, category, tags, workflow ID, price per call |
| `/dashboard/n8n/listings/[id]` | `N8nListingDetail` | Status, endpoints, payout wallet, edit, task history, delete (G10) |
| `/dashboard/n8n/api-keys` | `N8nApiKeys` | Table with prefix, permissions, spend, expiry |
| `/dashboard/n8n/api-keys/new` | `N8nApiKeyForm` | Create key — plaintext shown once |

### Dashboard API Routes

| Method | Path | Action |
| --- | --- | --- |
| POST | `/api/n8n/listings` | Create listing → Gateway registers on AgentDNS |
| GET | `/api/n8n/listings` | List developer's listings with status |
| PATCH | `/api/n8n/listings/:id` | Update name, summary, tags |
| DELETE | `/api/n8n/listings/:id` | Deactivate, stop heartbeat, delete |
| POST | `/api/n8n/api-keys` | Create key, return plaintext once |
| GET | `/api/n8n/api-keys` | List keys (prefix only, masked) |
| DELETE | `/api/n8n/api-keys/:id` | Revoke key (sets `revokedAt`) |

### Dashboard → Gateway internal API (G9)

The dashboard's `/api/n8n/*` routes (Vercel) call the Gateway server to server at `/internal/v1`. Each request carries `Authorization: Bearer <Session JWT>`.

**Session JWT:** HS256, header `{ "alg": "HS256", "typ": "JWT" }`, payload `{ "sub": "<developer_id>", "exp": <unix seconds> }` (`iat` and `nbf` optional), signed with `SESSION_JWT_SECRET` (at least 32 characters, shared with the dashboard). `exp` is mandatory. The dashboard should mint a token of about 5 minutes per request after it has authenticated the user and resolved their `developer_id`. The Gateway pins the algorithm to HS256, compares signatures in constant time, and scopes every route to `sub`.

| Method | Path | Action |
| --- | --- | --- |
| POST | `/internal/v1/listings` | Create a DRAFT listing (`name`, `summary`, `category`, `tags[]`, `workflowId?`, `priceUsd?`) and allocate its `derivedKeyIndex` |
| GET | `/internal/v1/listings` | The developer's listings, each with its heartbeat status |
| GET | `/internal/v1/listings/:id` | One listing |
| PATCH | `/internal/v1/listings/:id` | Edit any of `name`, `summary`, `tags`, `workflowId` (`null` clears) and `priceUsd` (`"0.05"`, `"0"` for free, `null` for the Gateway default). The Gateway record and agent card change; the AgentDNS copy keeps its registered values |
| DELETE | `/internal/v1/listings/:id` | Stop the heartbeat, forget the keypair, delete the listing. Tasks stay as history with a null `listingId` |
| POST | `/internal/v1/listings/:id/activate` | Register on AgentDNS (idempotent) and start the heartbeat when allowed |
| POST | `/internal/v1/listings/:id/deactivate` | ACTIVE → INACTIVE, stop the heartbeat |
| POST | `/internal/v1/api-keys` | `{ name, permissions?, spendCapUsd?, expiresAt? }` → 201 with the key fields **and `key`, the plaintext, shown once**. Stored: SHA-256 hash and the first 8 characters |
| GET | `/internal/v1/api-keys` | `{ keys }`, newest first, revoked ones included. Never the hash or the plaintext |
| DELETE | `/internal/v1/api-keys/:id` | Revoke (sets `revokedAt`, keeps the first timestamp). The key fails on its next request |
| GET | `/internal/v1/tasks?listingId&direction&limit&offset` | `{ tasks }`, newest first, `limit` 1-100. Metadata only (status, counterparty, payment, error, timestamps); never `input` or `output` |
| GET | `/internal/v1/wallet` | `{ payer, listings: [{ listingId, name, address }] }`: the EVM address that pays for outbound calls and each listing's receiving address. Public addresses only |

Another developer's listing answers `404 NOT_FOUND`, never 403, so ids cannot be probed. `webhookSecretEnc` is never returned. A registry failure answers `502 GATEWAY_UNAVAILABLE` with `details.agentDnsStatus` and leaves the listing in ERROR; calling `activate` again retries. The dashboard never reads the `n8n_*` tables itself; it goes through these routes (G12).

---

## Database Schema

Gateway adds these tables to the shared Postgres database (defined in `src/db/schema.ts`). The existing dashboard table `developer_keys` is read-only from the Gateway; a developer is a row there, identified by its unique `developer_id` (`zns:dev:…`), which is what every `developerId` column below references.

### N8nApiKey

| Column | Type | Notes |
| --- | --- | --- |
| `id` | String | Primary key (cuid) |
| `developerId` | String | FK → developer_keys.developer_id |
| `name` | String | Human label |
| `keyHash` | String (unique) | SHA-256 of plaintext API key |
| `keyPrefix` | String | First 8 chars, for display |
| `permissions` | String[] | Default: search, call, complete |
| `spendCapUsd` | Decimal? | Optional spend limit |
| `spentUsd` | Decimal | Running total, default 0 |
| `expiresAt` | DateTime? | Optional expiry |
| `lastUsedAt` | DateTime? | Updated on each request |
| `revokedAt` | DateTime? | Soft-delete timestamp |
| `createdAt` / `updatedAt` | DateTime | Auto |

### N8nListing

| Column | Type | Notes |
| --- | --- | --- |
| `id` | String | Primary key (cuid) |
| `developerId` | String | FK → developer_keys.developer_id |
| `name` | String | Agent display name |
| `summary` | String | One-line description |
| `category` | String | Agent category |
| `tags` | String[] | Searchable tags |
| `entityId` | String? (unique) | AgentDNS entity ID, set after registration |
| `derivedKeyIndex` | Int | HD derivation index for this listing's keypair. Allocated from `N8nDerivationCounter`, unique per developer, never reused |
| `webhookUrl` | String? | n8n webhook URL, set by ZyndTrigger |
| `webhookSecretEnc` | String? | AES-256-GCM ciphertext of the webhook secret (decrypted to send in `X-Zynd-Webhook-Secret`) |
| `workflowId` | String? | n8n workflow ID, for reference |
| `priceUsd` | Decimal(18,6)? | Price of one inbound call. Null = the Gateway default `X402_INBOUND_PRICE_USD`; `0` = free (G17) |
| `status` | Enum | DRAFT → REGISTERING → ACTIVE / INACTIVE / ERROR |
| `createdAt` / `updatedAt` | DateTime | Auto |

### N8nTask

| Column | Type | Notes |
| --- | --- | --- |
| `id` | String | Primary key (cuid) |
| `developerId` | String | FK → developer_keys.developer_id. Always set; outbound tasks are signed with the developer's master key |
| `listingId` | String? | FK → N8nListing. Null for outbound calls |
| `apiKeyId` | String? | FK → N8nApiKey (outbound only) |
| `callerId` | String? | Entity ID of calling agent (inbound) |
| `direction` | Enum | INBOUND or OUTBOUND |
| `input` | Json | Task input payload |
| `output` | Json? | Task result |
| `status` | Enum | PENDING → PROCESSING → COMPLETED / FAILED / TIMEOUT |
| `paymentTxn` | String? | x402 transaction hash |
| `paymentUsd` | Decimal? | Payment amount |
| `error` | String? | Error message on failure |
| `createdAt` / `updatedAt` | DateTime | Auto |

### N8nHeartbeat

| Column | Type | Notes |
| --- | --- | --- |
| `id` | String | Primary key (cuid) |
| `listingId` | String (unique) | FK → N8nListing, one per listing |
| `status` | Enum | CONNECTING → ACTIVE / RECONNECTING / FAILED / STOPPED (deliberate `stop()`) |
| `lastBeatAt` | DateTime? | Last successful heartbeat send |
| `failCount` | Int | Consecutive failures, default 0 |
| `createdAt` / `updatedAt` | DateTime | Auto |

### N8nDerivationCounter

Allocator for `N8nListing.derivedKeyIndex` (G13).

| Column | Type | Notes |
| --- | --- | --- |
| `developerId` | String | Primary key, FK → developer_keys.developer_id |
| `nextIndex` | Int | Next free index, default 0. Increment atomically; deleting a listing never frees an index |
| `updatedAt` | DateTime | Auto |

### N8nNonce

Replay store for `x-zynd-auth` (G5). Inserting an existing `nonce` fails, so "seen before" is atomic. Rows past `expiresAt` are purged periodically.

| Column | Type | Notes |
| --- | --- | --- |
| `nonce` | String | Primary key |
| `expiresAt` | DateTime | Indexed, for purging |
| `createdAt` | DateTime | Auto |

### Migration ownership (G12)

The Gateway repo owns migrations for the `n8n_*` tables only, via drizzle-kit (`npm run db:generate`, `npm run db:migrate`). `developer_keys` is mirrored in `src/db/dashboard.ts` (columns the Gateway reads, plus the NOT NULL `name`) so foreign keys resolve and keys can be read. That file is not in drizzle-kit's schema entry, and `tablesFilter: ['n8n_*']` backs it up, so they are never migrated from here. Drizzle records applied migrations in its own `drizzle.__drizzle_migrations` table, so it cannot collide with the dashboard's migration history, and no baseline step is needed. Keep the mirrored columns in step with the dashboard schema.

---

## Error Handling

All Gateway errors follow the shape `{ error, code, details? }`. The n8n node maps every non-2xx response to `NodeApiError`.

| Condition | Code | HTTP | n8n Node Behaviour |
| --- | --- | --- | --- |
| Invalid API key | `AUTH_INVALID` | 401 | NodeApiError: Invalid API key |
| Key expired | `AUTH_EXPIRED` | 401 | NodeApiError: API key expired |
| Permission denied | `AUTH_FORBIDDEN` | 403 | NodeApiError: Requires permission X |
| Spend cap exceeded | `PAYMENT_CAP` | 402 | NodeApiError: Spend cap exceeded |
| Agent not found | `NOT_FOUND` | 404 | NodeApiError: Agent not found |
| Listing inactive | `LISTING_INACTIVE` | 409 | NodeApiError: Listing is not active |
| Task timeout | `TASK_TIMEOUT` | 504 | NodeApiError: Task timed out after 300 s |
| Gateway unavailable | `GATEWAY_UNAVAILABLE` | 502 | NodeApiError: Gateway unavailable |
| x402 payment failed | `PAYMENT_FAILED` | 402 | NodeApiError: Payment failed |
| Webhook secret mismatch | — | — | Trigger silently drops the request |
