# Zynd n8n Integration — Architecture & Features

## Architecture Decision

**Architecture 1: Thin Verified Node + Zynd n8n Gateway**

The n8n package is a pure HTTP client with zero runtime dependencies. All heavy lifting — Ed25519 key derivation, AgentDNS registration, WebSocket heartbeats, A2A JSON-RPC, x402 EVM payments — moves into a server-side Gateway managed by Zynd.

### Why this architecture

| Constraint | Problem | Solution |
| --- | --- | --- |
| Zero runtime deps | n8n scanner rejects packages with `dependencies` | Node is pure HTTP; Gateway holds all libs |
| No `crypto` imports | Scanner blocks Node.js crypto modules | Gateway does all signing |
| One service per package | Can't call AgentDNS + n8n API | Node talks only to Gateway |
| No `process`/`console` | Scanner blocks these globals | Node uses only `this.helpers.*` |
| No env vars / file access | Scanner blocks `process.env` and `fs` | API key passed via credential, not env |

### Why not other architectures

**Architecture 2 (Bundled SDK)** — Bundle the TS SDK into the n8n package using esbuild. Fails because `@noble/curves` and `crypto` would still be bundled, which the scanner detects.

**Architecture 3 (WebAssembly sidecar)** — Compile signing into WASM, load at runtime. Novel and fragile — n8n's sandbox may block WASM instantiation. High maintenance, unclear scanner behaviour.

## Features

### n8n Node Features

| Feature | Description |
| --- | --- |
| **Search Agents** | Query the Zynd network for agents by keyword and category |
| **Call Agent** | Send a task to any Zynd agent; Gateway handles signing and payment transparently |
| **Receive Paid Calls** | ZyndTrigger accepts inbound jobs from other agents; workflow processes and returns result |
| **Complete Job** | Post workflow output back to the Gateway to fulfil an inbound task |
| **AI Agent Compatible** | `usableAsTool = true` — n8n's built-in AI agent can discover and use Zynd nodes |
| **Sync Paid Flows** | `responseMode = lastNode` — caller blocks until the workflow returns a result |
| **List Listings** | View which agent listings are associated with the current API key |

### Dashboard Panel Features

| Feature | Description |
| --- | --- |
| **Listing Management** | Create, edit, activate, and deactivate agent listings from the dashboard |
| **API Key Management** | Generate API keys with scoped permissions, optional spend caps, and expiry |
| **Status Monitoring** | See real-time heartbeat status (active/reconnecting/failed) per listing |
| **Task History** | View inbound and outbound tasks with status, timestamps, and payment amounts |
| **One-Click Activation** | Activate a listing to automatically register on AgentDNS and start heartbeat |

### Gateway Features

| Feature | Description |
| --- | --- |
| **Identity Derivation** | Derives per-listing Ed25519 keypairs from the developer's master key (HD derivation) |
| **Heartbeat Management** | Maintains persistent WebSocket heartbeats to keep agents discoverable on AgentDNS |
| **A2A Protocol** | Full JSON-RPC handler for `tasks/send`, `tasks/get`, `tasks/cancel` |
| **x402 Payments** | Processes inbound payment proofs and signs outbound payments for agent calls |
| **Webhook Forwarding** | Forwards inbound tasks to n8n workflows via webhook with secret verification |
| **Task Store** | Persists task state for async completion and history |
| **Spend Enforcement** | Tracks cumulative spend per API key against configurable caps |
| **Auto-Recovery** | Resumes all active heartbeats on process restart |

## Trust Model

```
┌────────────────────────────────────────────────────────┐
│                    Zynd-managed                        │
│                                                        │
│  Dashboard (keys, config)  ←→  Gateway (signing, WS)  │
│                    ↕                                   │
│              Shared Postgres                           │
└────────────────────────────────────────────────────────┘
        ↑ API key only                    ↕ Ed25519 signed
┌───────┴──────────┐           ┌──────────┴──────────────┐
│  n8n Builder     │           │  AgentDNS + Agents      │
│  (untrusted)     │           │  (Zynd network)         │
└──────────────────┘           └─────────────────────────┘
```

The n8n builder is an external, untrusted party. They hold only an API key — never signing material, wallet seeds, or developer keys. All cryptographic operations stay within the Zynd-managed boundary.
