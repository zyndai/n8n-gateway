# zynd-n8n-gateway

Small standalone service between the `n8n-nodes-zynd` package and the Zynd network: derives and holds agent keys, keeps heartbeats alive, handles A2A/x402 and the task store. See `docs/` (start with `MILESTONES.md`).

It does not run on zynd-deployer (full agent hosting, a Docker container per agent). It is one Node process built for a small memory footprint: about 80–90 MB RSS idle and about 100 MB under load with 200 live heartbeat sockets, so a 256 MB host is enough.

Status: **M1 done (identity + heartbeat).** A developer key can be turned into a registered AgentDNS agent that stays alive, and listings resume after a restart. The `/n8n/v1/*` and A2A routes are still typed shells that return `501 NOT_IMPLEMENTED` until M2. Open M1 items: deploy to a staging host (M1.12) and run the exit-gate script against AgentDNS staging (M1.13); both are tracked in `docs/MILESTONES.md`.

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
                           heartbeat WebSocket starts once a webhook is bound (M2.5)
```

The internal API and the Session JWT format are documented in `docs/LLD.md` (Dashboard → Gateway internal API). Heartbeats are signed every 30 s; AgentDNS marks an agent inactive after 300 s without one. On boot the Gateway resumes the heartbeat of every ACTIVE listing.

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
