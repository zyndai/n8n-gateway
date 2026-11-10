# Zynd n8n Integration — High-Level Design

## Architecture

The n8n node is a thin HTTP client. The Gateway handles everything else.

```
                        ┌──────────────────┐
                        │    Dashboard     │
                        │ Keys, listings   │
                        └───────┬──────────┘
                                │ Session JWT
                                ▼
┌─────────────────┐  API key  ┌──────────────────────┐  Ed25519   ┌──────────────┐
│   Zynd node     │─────────▶│  Zynd n8n Gateway    │◀─────────▶│  AgentDNS    │
│   search, call  │          │                      │           │  register    │
└─────────────────┘          │  Derives agent keys  │           │  heartbeat   │
┌─────────────────┐  Job     │  Manages heartbeats  │  A2A+x402 └──────────────┘
│  Zynd Trigger   │◀────────│  Handles A2A + x402  │◀─────────▶┌──────────────┐
│  webhook        │          │  Forwards jobs       │           │ Other agents │
└─────────────────┘          │  Stores tasks        │           │ call + pay   │
    Your n8n instance         └──────────┬───────────┘           └──────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │   Shared Postgres    │
                              │ Keys, listings, tasks│
                              └──────────────────────┘
```

The Gateway is the single service between the n8n node and the Zynd network. The node carries no secrets beyond its API key and no signing material. The Gateway derives keys, maintains heartbeats, handles the A2A protocol and processes x402 payments on behalf of n8n agent builders.

## Components

| Component | Responsibility | Owns |
| --- | --- | --- |
| `n8n-nodes-zynd` | Verified npm package. Two nodes (Zynd, ZyndTrigger), one credential (ZyndApi). Pure HTTP client | Nothing stateful |
| Zynd n8n Gateway | Identity derivation, heartbeats, A2A, x402, task store, webhook forwarding | N8nApiKey, N8nListing, N8nTask, N8nHeartbeat |
| Dashboard n8n panel | API key management, listing configuration, wallet display | Developer, DeveloperKey (existing) |
| Shared Postgres | Persistence for dashboard and Gateway | Data at rest |
| AgentDNS | Entity registry, search, heartbeat WebSocket | Entity state, search index |

## Data Flows

**1. Agent search** — n8n node calls `GET /n8n/v1/agents?q=weather`. Gateway proxies to AgentDNS `POST /v1/search`. Returns matching agents.

**2. Outbound call** — n8n node calls `POST /n8n/v1/agents/:id/tasks`. Gateway derives caller identity, signs A2A request, attaches x402 payment, POSTs to target agent's entity_url, polls for result, returns to n8n.

**3. Listing activation** — Dashboard creates listing. Gateway derives Ed25519 key at the listing's derivation index, signs registration, POSTs to AgentDNS `/v1/entities`, sets entity_url to `https://gw.zynd.ai/a/{entityId}`, starts heartbeat WebSocket. Agent is live.

**4. Inbound paid call** — Other agent POSTs to `/a/:entityId/a2a/v1` with `x-zynd-auth` and x402 headers. Gateway verifies signature and payment, creates task, forwards job to n8n webhook with shared secret. n8n workflow processes the job. n8n calls `POST /n8n/v1/jobs/:id/complete`. Gateway stores result, returns A2A response to caller.

**5. Trigger lifecycle** — n8n activates workflow: ZyndTrigger's `webhookMethods.create` calls `POST /n8n/v1/webhooks`. Gateway registers webhook and starts heartbeat. Agent goes live. On deactivation: `webhookMethods.delete` stops heartbeat. AgentDNS marks inactive after 300 s.

## Security Model

| Layer | Mechanism | Details |
| --- | --- | --- |
| n8n to Gateway | API key in `X-Zynd-Api-Key` | SHA-256 hash checked against DB; scoped permissions, spend cap, expiry |
| Gateway to n8n | Shared secret in `X-Zynd-Webhook-Secret` | ZyndTrigger verifies by string comparison |
| Gateway to AgentDNS | Ed25519 over canonical JSON | Derived per-listing keys; AgentDNS verifies public key |
| Gateway to agents | `x-zynd-auth` signatures | JCS canonicalisation, domain tag, nonce replay protection |
| x402 payments | EVM secp256k1 | Derived from Ed25519 via SHA-256; Gateway enforces spend caps |
| Key storage | AES-256-GCM at rest | Developer keys in dashboard DB; only hashes stored for API keys |

No signing material or wallet seeds are ever exposed to the n8n node.

## Infrastructure

| Service | Runs on | Reason |
| --- | --- | --- |
| Gateway | Its own small host (one process, 256 MB RAM is enough). Not on zynd-deployer | Persistent WebSocket connections; Vercel serverless would drop them. zynd-deployer is full agent-hosting infra (a Docker container per agent); the Gateway only holds keys and keeps heartbeats alive, so it stays a separate, minimal service |
| Dashboard | Existing Vercel deployment | New route group; no infra change |
| Postgres | Shared instance | Gateway adds its own tables; reads developer keys from existing tables |

The Gateway is a single-process Node.js service. Each active listing holds one WebSocket to AgentDNS, sending a signed timestamp every 30 s. One process handles several hundred connections. Measured footprint of the bundled build with 200 live sockets, a live Postgres pool and 6,000 dashboard requests at 40 concurrency: about 78–88 MB RSS idle and about 94–101 MB at peak, against 48 MB for a bare Node process (each socket costs about 63 KB; see PRD > Non-Functional Requirements). Scale horizontally with listing-to-instance affinity via consistent hashing on entity_id (M5.3, built): only the heartbeat sockets need an owner, so each instance holds the listings that rendezvous hashing assigns it among the instances alive, and HTTP stays stateless on all of them (tasks live in Postgres). Instances probe each other's `/health`; when one stops answering, the others start its listings' heartbeats within about 10 s (well inside AgentDNS's 300 s inactivity threshold), and hand them back when it returns. See `RUNBOOK.md` > Two instances.
