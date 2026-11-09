# Zynd n8n Integration — Product Requirements Document

## Project Overview

| Item | Detail |
| --- | --- |
| Project name | Zynd n8n Integration |
| New repos | `zynd-n8n-gateway` (Node.js service), `n8n-nodes-zynd` (npm package) |
| Modified repo | `dashboard` (new route group for n8n panel) |
| Shared infra | Existing Postgres (6 new tables; see LLD), shared with the dashboard |
| Separate, minimal host | Gateway runs as one small Node process (target: well under 256 MB RAM), not on zynd-deployer, which is full agent-hosting infra. Dashboard stays on Vercel |
| Why a new service | Dashboard runs on Vercel (serverless) — Gateway needs persistent WebSocket connections for AgentDNS heartbeats |

## Problem

n8n is the largest open-source workflow-automation platform. Its users build multi-step workflows by connecting nodes. Today there is no verified Zynd node on the n8n marketplace, so n8n builders cannot discover, call, or monetise Zynd agents from inside a workflow.

The previous attempt (`n8n-nodes-zyndai` v0.1.0) broke five n8n verification rules: eight runtime dependencies, Node.js `crypto` imports, called n8n's internal API as a second service, exposed wallet seeds in output, and had no npm provenance publish workflow.

## Personas

| Persona | Role | Uses |
| --- | --- | --- |
| n8n Builder | Builds workflows in n8n | Zynd node and ZyndTrigger inside workflows. Searches for agents, calls them, receives paid jobs. Never sees signing, heartbeats or wallet keys |
| Agent Developer | Manages agents via the Zynd Dashboard | n8n panel in Dashboard. Creates listings, generates API keys, monitors tasks |
| Calling Agent | Another Zynd agent calling an n8n-hosted agent | A2A JSON-RPC + x402 payment against the Gateway. Discovers agents through AgentDNS search |

## Functional Requirements

### P0 — Must have for launch

- **Search agents** — Zynd node queries AgentDNS through the Gateway and returns matching agents
- **Call agent** — Zynd node sends a task to any Zynd agent via the Gateway; Gateway handles Ed25519 signing, A2A protocol, and x402 payment
- **Receive paid calls** — ZyndTrigger receives inbound jobs forwarded by the Gateway; the workflow processes and returns the result
- **API key auth** — Every node request carries an API key in `X-Zynd-Api-Key`; Gateway validates SHA-256 hash against DB
- **Listing management** — Dashboard panel lets developers create, activate and deactivate agent listings
- **API key management** — Dashboard panel lets developers create and revoke API keys with permissions and optional spend caps
- **Heartbeat** — Gateway maintains WebSocket heartbeat (30 s interval) per active listing; AgentDNS marks agents inactive after 300 s
- **npm publish with provenance** — CI workflow publishes with `npm publish --provenance` on version tags
- **Scanner compliance** — Package passes `npx @n8n/scan-community-package` with zero issues

### P1 — Should have

- **Spend caps** — API keys carry an optional USD spend cap; Gateway rejects outbound calls that would exceed it
- **Task history** — Dashboard shows inbound and outbound task history per listing
- **usableAsTool** — Zynd node sets `usableAsTool = true` so n8n's AI agent can discover and invoke it
- **Webhook secret verification** — ZyndTrigger verifies `X-Zynd-Webhook-Secret` on every inbound payload

### P2 — Nice to have

- **Listing analytics** — Call volume, revenue, and error rate per listing over time
- **Multi-listing per workflow** — One n8n workflow serves multiple listings through a single ZyndTrigger
- **Key rotation** — Rotate API keys with a grace period for the old key

## Non-Functional Requirements

- **Latency** — Gateway adds < 50 ms to a proxied AgentDNS search (p99)
- **Availability** — Gateway uptime target: 99.5%
- **Heartbeat reliability** — Reconnect with exponential backoff (1 s → 30 s max); resume all active heartbeats on process restart
- **Security** — No signing material or wallet seeds exposed to the n8n node. API key hashes only in DB. Developer keys encrypted at rest (AES-256-GCM)
- **Memory footprint** — Gateway process idles at ≤ 95 MB RSS and peaks at ≤ 110 MB under load with 200 live heartbeat sockets, with a 96 MB heap cap, so a 256 MB host is enough. Measured in M1.14 on the bundled build with a live Postgres pool, 200 heartbeat sockets recovered on boot, and 6,000 dashboard requests at 40 concurrency plus 200 × 97 KB list responses: idle 78–88 MB, peak 94–101 MB (runs vary ±5 MB). Each heartbeat socket costs about 63 KB, so budget roughly 75 MB + 0.06 MB per socket. This revises the earlier 80 / 100 MB figures, which were measured with only `/health` exercised and no sockets. `npm start` adds `--max-semi-space-size=2 --optimize-for-size`, which cut the load peak from about 160 MB to about 100 MB with no change in throughput. Re-run with `npm run measure:memory`
- **Package size** — n8n package < 50 KB unpacked (no runtime deps)
- **Compliance** — MIT licence, English metadata, `n8n-community-node-package` keyword, peer dep on `n8n-workflow`

## Scope

**In scope:** n8n-nodes-zynd npm package, zynd-n8n-gateway service, dashboard n8n panel, Drizzle schema additions, CI/CD for both repos.

**Out of scope:** Zynd Bridge node, multi-chain x402, agent hosting (stays in zynd-deployer), AgentDNS changes, mobile dashboard.

## Success Metrics

| Metric | Target | Timeframe |
| --- | --- | --- |
| npm package published with provenance | Yes | Week 4 |
| n8n scanner passes | Zero issues | Week 4 |
| Creator Portal submission filed | Yes | Week 4 |
| Beta builders with live agents | ≥ 5 | Week 6 |
| End-to-end paid call latency | < 2 s (p50) | Week 6 |
| Gateway uptime | ≥ 99.5% | Post-launch month 1 |

## Dependencies and Assumptions

- AgentDNS API is stable and staging environment is available
- Dashboard Postgres instance has capacity for 4 additional tables
- A small always-on host (about 256 MB RAM, outbound WebSockets, Postgres reachable) is available for the Gateway; zynd-deployer is not used
- n8n Creator Portal is accepting submissions
- Developer keys in dashboard DB use AES-256-GCM and the same decryption path works from the Gateway
- The TS SDK's Ed25519 functions are stable and can be called from the Gateway without importing the full SDK
