# zynd-n8n-gateway

Small standalone service between the `n8n-nodes-zynd` package and the Zynd network: derives and holds agent keys, keeps heartbeats alive, handles A2A/x402 and the task store. See `docs/` (start with `MILESTONES.md`).

It does not run on zynd-deployer (full agent hosting, a Docker container per agent). It is one Node process built for a small memory footprint: about 80–90 MB RSS idle and about 100 MB under load with 200 live heartbeat sockets, so a 256 MB host is enough.

Status: **M2 implemented (A2A + x402); M3 (`n8n-nodes-zynd`) and M4 (dashboard panel) built in the sibling repos `../n8n-nodes-zynd` and `../dashboard`, none of it run on staging.** M1: a developer key becomes a registered AgentDNS agent that stays alive and resumes after a restart. M2: the Gateway serves the n8n API (`docs/N8N_API.md`), accepts signed, optionally paid A2A calls and forwards them to an n8n webhook, and makes paid outbound calls with spend caps. M4 added the dashboard's routes on this side: listing edit and delete, API keys, task history and wallet addresses under `/internal/v1` (`docs/LLD.md`). `test/n8nNodes.e2e.test.ts` and `test/dashboard.interop.test.ts` run the real package and the real dashboard client against this Gateway; they skip if the sibling repos are not checked out next to this one. Open: deploy to a staging host (M1.12), the staging runs (M1.13, M2.14, M2.17), and the choices recorded as G17-G20 in `docs/MILESTONES.md`.

```
npm install
cp .env.example .env   # set DATABASE_URL, PKI_ENCRYPTION_KEY, SESSION_JWT_SECRET
npm run dev            # http://localhost:8080/health
npm run lint && npm run typecheck && npm test && npm run build
npm start              # runs dist/index.mjs with a 96 MB heap cap
```

`PKI_ENCRYPTION_KEY` is the dashboard's key (64 hex characters). With `DATABASE_URL` set the Gateway refuses to start without it; without `DATABASE_URL` it serves `/health` only.

## How a listing goes live

```
dashboard ──Session JWT──▶ POST /internal/v1/listings            create DRAFT, allocate derivedKeyIndex
                           POST /internal/v1/listings/:id/activate
                              decrypt developer key → derive agent key → sign registration + derivation proof
                              POST AgentDNS /v1/entities  (entity_url = {PUBLIC_URL}/a/{entityId})
                              listing ACTIVE
                           heartbeat WebSocket starts once a webhook is bound (POST /n8n/v1/webhooks)
```

The internal API and the Session JWT format are documented in `docs/LLD.md` (Dashboard → Gateway internal API). Heartbeats are signed every 30 s; AgentDNS marks an agent inactive after 300 s without one. On boot the Gateway resumes the heartbeat of every ACTIVE listing.

## n8n API, A2A and x402

- `/n8n/v1/*`: the contract the n8n nodes build against is `docs/N8N_API.md` (types in `src/n8nContract.ts`). Needs an API key in `X-Zynd-Api-Key`; keys are stored as SHA-256 hex hashes in `n8n_api_key` (the dashboard creates them in M4).
- `POST /a/:entityId/a2a/v1`: A2A JSON-RPC for other agents. Callers sign with `x-zynd-auth` inside `params.message.metadata`.
- `GET /a/:entityId/.well-known/agent-card.json`: the signed A2A Agent Card SDK clients use to find the endpoint above.
- x402 is configured with `X402_*` (see `.env.example`). A listing's own `priceUsd` (set via the dashboard API) wins; `X402_INBOUND_PRICE_USD` is the default for the rest, and with neither set inbound calls are free.

## Database (Drizzle + Postgres)

- Schema: `src/db/schema.ts` (Gateway tables, all named `n8n_*`). `src/db/dashboard.ts` mirrors the dashboard-owned `developer_keys` table (read-only; foreign keys point at `developer_keys.developer_id`). It is never migrated from here.
- Migrations live in `src/db/migrations`. Drizzle keeps its history in its own `drizzle` schema, so it does not interfere with the dashboard's migrations.

```
npm run db:generate    # after editing schema.ts; commit the generated SQL
DATABASE_URL=... npm run db:migrate
npm run db:check       # validates the migration history (used in CI)
```

## Tests

`npm test` runs without any services: crypto (checked against vectors produced by the TS SDK), the state machine, the heartbeat manager with fake sockets and timers, the session JWT, the dashboard routes and the registration flow against an in-process fake AgentDNS that verifies signatures the way the Go registry does.

With a database it also runs the Postgres-backed tests, including concurrent derivation-index allocation and the full register → heartbeat → stop → restart flow over real sockets. The database needs the dashboard's `developer_keys` table before the Gateway migrations (a test fixture is provided; never run it against production):

```
psql $TEST_DATABASE_URL -f test/fixtures/dashboard-developer-keys.sql
DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate
TEST_DATABASE_URL=postgresql://... npm test
```

CI does exactly this with a Postgres service.

**Against a real AgentDNS node** (opt-in, M1.13): `test/agentdns.e2e.test.ts` registers a listing, checks the node accepts the signatures and heartbeats, and, if `E2E_INACTIVE_THRESHOLD_S` is set, proves the agent stays active past the node's inactivity threshold while beating and goes inactive after it stops. The header of that file lists the environment variables. The developer must already be registered on the node (`agentdns dev-init`, `agentdns dev-register`).

## Memory

`npm run build` bundles everything into one minified file with esbuild. Loading drizzle-orm and express from `node_modules` as separate files idled at about 185 MB; the bundle is far smaller (a bare Node process is 48 MB). `npm start` also passes `--max-semi-space-size=2 --optimize-for-size`, which cut the peak under load from about 160 MB to about 100 MB with no change in throughput. Keep new dependencies light and import only what you use.

Each heartbeat socket costs about 63 KB. To re-measure with a live database and 200 sockets (needs `npm run build` first):

```
DATABASE_URL=postgresql://... npm run measure:memory
```

Last measured (M1.14): idle 78–88 MB, peak 94–101 MB. The script exits non-zero if it goes over the budget in the PRD.

After M2 (same machine, same script, two runs each): the M1 build idled at 91.0–91.6 MB and peaked at 102–104 MB; the M2 build idled at 95.3–95.8 MB and peaked at 107.7–107.9 MB. That is about +4 MB, which puts idle just over the 95 MB budget (the script reports it as missed). The cause is not isolated: importing `@noble/curves/secp256k1` costs only ~0.3 MB, but its first *use* (the first x402 signature) adds ~4 MB more at runtime. Decide whether to raise the budget or hunt for the delta before M5.
