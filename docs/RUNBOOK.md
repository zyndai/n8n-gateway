# Gateway runbook

For whoever runs the Gateway. Covers configuration, monitoring (M5.1), rate limits (M5.2), crash recovery of payments (M2.20), rollback (M5.5) and Zynd Studio. The host is still undecided (M0.18); nothing here depends on which one it is, only on one Node 20+ process, Postgres and outbound HTTPS/WebSockets.

## Configuration

Set in the process environment (`.env.example` lists every variable).

| Variable | Needed | Notes |
| --- | --- | --- |
| `DATABASE_URL` | for anything beyond `/health` | Without it the Gateway serves `/health` and `/metrics` only |
| `PKI_ENCRYPTION_KEY` | with `DATABASE_URL` | The dashboard's key. Also seals webhook secrets and payment proofs. Losing or changing it makes both unreadable |
| `SESSION_JWT_SECRET` | with the dashboard or Studio | Same value on the dashboard host and in Studio, 32+ characters |
| `STUDIO_SERVICE_TOKEN` | with Studio | 32+ characters, the same value in Studio. Unset = `POST /internal/v1/provision` does not exist |
| `AGENTDNS_WEBHOOK_SECRET` | with Studio | The registry's admin secret (the dashboard's value). Lets the Gateway create developer identities for Studio. Unset = provisioning answers 502 |
| `PUBLIC_URL` | yes | `entity_url` of every listing is `{PUBLIC_URL}/a/{entityId}`; changing it moves every agent |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST` | optional | Default 300 and 60 per API key; `RATE_LIMIT_PER_MINUTE=0` turns the limit off |
| `METRICS_TOKEN` | optional | Enables `GET /metrics` |
| `INSTANCE_ID`, `CLUSTER_PEERS` | with 2+ instances | See Two instances. Unset = one instance that owns every heartbeat |
| `X402_RPC_URL` | optional | JSON-RPC node for the wallet balances in the dashboard (G21). Defaults to the public Base / Base Sepolia node; an unreadable balance shows as a dash and never fails the page |
| `X402_*` | for paid listings | Defaults point at Base Sepolia test USDC. Mainnet needs all of them set and a production facilitator (G18) |

## Start, stop

`npm run build`, then `npm start`. On boot the Gateway resumes the heartbeat of every ACTIVE listing and runs a payment recovery pass; on SIGTERM it closes the heartbeat sockets without touching the database, so listings resume on the next start. Agents are marked inactive by AgentDNS after 300 s without a beat, so a restart that takes under a few minutes is invisible to the registry.

Migrations: `DATABASE_URL=... npm run db:migrate`. Run them before starting a new version.

## Two instances (M5.3)

Only the heartbeat sockets are tied to an instance. Requests (`/a/*`, `/n8n/v1/*`, `/internal/v1/*`) are stateless because tasks, nonces and keys live in Postgres, so put both instances behind one load balancer on `PUBLIC_URL`. Two small differences: the rate limit is per instance (a key can spend up to twice its allowance across two), and a `jobs/complete` that lands on the other instance wakes the waiting call by the 2 s poll instead of at once.

Setup, for `gw-1` and `gw-2` (same `DATABASE_URL`, `PKI_ENCRYPTION_KEY`, `SESSION_JWT_SECRET`, `PUBLIC_URL`):

```
# on gw-1
INSTANCE_ID=gw-1  CLUSTER_PEERS=gw-2=http://10.0.0.2:8080
# on gw-2
INSTANCE_ID=gw-2  CLUSTER_PEERS=gw-1=http://10.0.0.1:8080
```

The peer URL only has to reach the other instance's `/health`. Each instance must list every other one, with the same ids everywhere; an entry that repeats an id or names the instance itself stops the boot.

How it behaves:

- Each ACTIVE listing's socket sits on the instance that rendezvous hashing on the entity id picks among the instances alive. Roughly half each with two.
- Every 5 s an instance probes its peers; after 2 failures in a row (about 10 s) it counts a peer as dead and starts that peer's listings (immediately, not at the next reconcile). A returning peer is seen on the first good probe; the other instance then closes its copy and leaves the heartbeat row alone, because the returning one is writing it.
- Every 15 s an instance re-reads the ACTIVE listings and starts the ones it owns and lacks, so a listing activated through the other instance goes live within 15 s, and one deactivated elsewhere is stopped after two rounds without it.
- `gateway_cluster_live_instances` shows how many instances this one sees. Alert when it stays below the number you run for 2 minutes. `gateway_heartbeats_active` per instance should sum to the number of active listings.
- Killing one instance never leaves agents inactive: AgentDNS waits 300 s without a beat, the takeover takes about 10-25 s.

If the instances cannot reach each other's `/health` but both reach Postgres and AgentDNS, each assumes the other is dead and holds every listing. That costs one duplicate socket per listing and nothing else.

Auto-restart is the host's job. A systemd unit needs `Restart=always` and `RestartSec=2`; a container needs `restart: unless-stopped` and a health check on `GET /health`. These are not shipped here because the host is still undecided (M0.18).

## Monitoring (M5.1)

`GET /metrics` (Prometheus text) needs `Authorization: Bearer $METRICS_TOKEN`; without the variable the route does not exist. `GET /health` is liveness only and never touches the database.

| Metric | Use |
| --- | --- |
| `gateway_uptime_seconds` | Restarts (value drops) and availability together with the scrape's own `up` |
| `gateway_cluster_live_instances` | Instances this one sees alive, itself included (only meaningful with `CLUSTER_PEERS`); below the number you run for 2 minutes means a peer is down or unreachable |
| `gateway_heartbeats_active` | Should equal the number of ACTIVE listings with a webhook; a drop without a deploy means sockets are failing |
| `gateway_http_requests_total{group,status}` | Error rate: `status="5xx"` over all, per `group` (`n8n`, `a2a`, `card`, `internal`, `health`) |
| `gateway_http_request_duration_seconds` | Histogram per group; p99 with `histogram_quantile(0.99, ...)`. `a2a` includes the wait for the n8n workflow (up to 300 s), so judge its latency on `n8n` and `internal` |
| `process_resident_memory_bytes` | Against the memory budget (idle ≤ 95 MB, peak ≤ 110 MB, PRD) |
| `gateway_rate_limited_total`, `gateway_rate_limit_keys` | How many requests the limiter turned away; keys currently tracked |

Suggested alerts (tune after the beta):

| Alert | Condition |
| --- | --- |
| Gateway down | `/health` fails or the scrape's `up == 0` for 2 minutes |
| Error rate | 5xx over 5 % of requests for 5 minutes |
| Slow API | p99 of `group="n8n"` over 2 s for 10 minutes |
| Heartbeats dropped | `gateway_heartbeats_active` falls by more than 20 % in 5 minutes |
| Memory | `process_resident_memory_bytes` over 120 MB for 10 minutes |
| Rate limiting | `rate(gateway_rate_limited_total[5m])` above 1 for 15 minutes (a key is hammering, or the limit is too low) |

The dashboards and alert routing themselves are set up in whatever monitoring the host provides; that part of M5.1 is not in this repo.

## Rate limits (M5.2)

Every `/n8n/v1/*` request spends one token from the calling API key's bucket (`RATE_LIMIT_BURST` tokens, refilled at `RATE_LIMIT_PER_MINUTE` / 60 per second). Over the limit: HTTP 429, code `RATE_LIMITED`, `Retry-After` in seconds; every response carries `RateLimit-Limit` and `RateLimit-Remaining`. Requests with an unknown key are rejected before any bucket is touched. The A2A endpoint, agent cards and the dashboard API are not limited by this.

Buckets live in the process. With more than one instance (M5.3) each enforces its own, so the effective limit is up to instances × the setting unless a key always reaches the same instance.

## Payments after a crash (M2.20)

A paid inbound call is verified before the job runs and settled after it completes. The verified proof is stored (encrypted) on the task, and a recovery pass runs at boot and every minute:

- COMPLETED task still holding a proof for over 30 s: settled, once.
- FAILED, TIMEOUT or CANCELED task: proof dropped, nobody charged.
- Open task older than 6 minutes: marked TIMEOUT, proof dropped.
- Authorization past its `validBefore`: dropped.

Nothing to do by hand. To see what is outstanding: `SELECT id, status, "updatedAt" FROM n8n_task WHERE "paymentProofEnc" IS NOT NULL;`. Rows that stay there for more than a few minutes after COMPLETED mean the facilitator is unreachable; they are retried every minute until the authorization expires.

## Rollback (M5.5)

The Gateway and the dashboard release independently. They meet at two frozen contracts, `/n8n/v1/*` (`N8N_API.md`) and `/internal/v1/*` with the Session JWT (`LLD.md`), and both only ever gain fields, so either side can be rolled back alone.

Roll the Gateway back:

1. Redeploy the previous build (`dist/index.mjs` of the previous tag). Keep the environment as it is.
2. Do not roll the database back. Every migration so far only adds (an enum value, nullable columns, a new table), and older builds ignore what they do not know. Never drop a column to "undo" a release.
3. Check `/health`, then `gateway_heartbeats_active` returns to the number of active listings within a minute (heartbeats resume on boot).
4. Tell nobody to change anything: the dashboard and the n8n package keep working against the older Gateway, except for features that are new in the rolled-back release (the dashboard shows the Gateway's error for those).

Things to know when rolling back across a specific release:

| Rolling back past | Effect |
| --- | --- |
| Migration 0003 (payment proofs, M2.20) | Proofs already stored stay in the table and are not settled until you roll forward again. Settle or release them first if you can wait: let the recovery pass run before the rollback |
| Migration 0002 (listing price) | Older builds ignore `priceUsd`: listings charge the default price (`X402_INBOUND_PRICE_USD`, or nothing) |
| Migration 0001 (CANCELED status) | Older builds do not know the CANCELED value; avoid rolling back past it while canceled tasks exist |

Roll the dashboard back separately (Vercel). The Gateway does not need to change: it only reads the Session JWT and the shared `developer_keys` table.

If a bad release is a bad migration, fix forward with a new migration; Drizzle records applied migrations in `drizzle.__drizzle_migrations`.

## Zynd Studio

Studio (`apps/studio`, [plan](STUDIO_PLAN.md)) is one more container next to the Gateway and n8n. It has no database and is not needed by either.

**Server setup, once**

1. Point a subdomain (for example `studio.thenorthbound.agency`) at the server and add it to the reverse proxy, forwarding to `127.0.0.1:3100`. Nginx:

   ```nginx
   server {
     server_name studio.thenorthbound.agency;
     listen 443 ssl;                       # certificate lines as for the Gateway's server block
     location / {
       proxy_pass http://127.0.0.1:3100;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     }
   }
   ```

   Caddy: `studio.thenorthbound.agency { reverse_proxy 127.0.0.1:3100 }`.
2. Create `/opt/zynd-n8n-gateway/studio.env` (mode 600) from [`apps/studio/.env.example`](../apps/studio/.env.example). Start with `STUDIO_PREVIEW=1`, `STUDIO_PUBLIC_URL`, and `SESSION_JWT_SECRET` (any 32+ characters in preview): that serves the sample screens. For sign-in, add the Supabase pair, `STUDIO_SERVICE_TOKEN`, `N8N_API_KEY` and `N8N_MCP_TOKEN`, and unset `STUDIO_PREVIEW`.
3. Add `STUDIO_SERVICE_TOKEN` and `AGENTDNS_WEBHOOK_SECRET` to the Gateway's `/opt/zynd-n8n-gateway/.env`, and restart the Gateway (the next deploy does it).
4. In the zynd.ai Supabase project, add `{STUDIO_PUBLIC_URL}/auth/callback` to the allowed redirect URLs.

**Agent builder and agents (S2, S3).** These need more in `studio.env`; each is listed with its default in [`apps/studio/.env.example`](../apps/studio/.env.example):

| Setting | What it is | Without it |
| --- | --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | The platform's OpenAI key and the model that drives the builder chat | Create agent shows "not switched on yet" |
| `N8N_OPENAI_CREDENTIAL_ID` | The id of the platform's "OpenAI account" credential in n8n. Agents may use that credential and no other | Same |
| `AGENT_MODEL` | The model agents run on in n8n (default `gpt-5.4-mini`); any other model in a workflow is refused | Default |
| `AIRNODE_SOURCES` | JSON array of the AirnodeHub operations the builder may give an agent (name, listingUrl, operation, what, maxPriceUsd, fields) | Agents can hire helpers and read the web, but use no data sources |
| `TREASURY_PRIVATE_KEY` | The platform wallet that sends each new agent starter credit. Needs test aUSD and a little Base Sepolia ETH | Agents are created with no credit |
| `STARTER_CREDIT_USD`, `STARTER_CREDIT_MAX_AGENTS` | Credit per agent (default 1) and how many of a person's first agents get it (default 3) | Defaults |
| `AGENT_MAX_CALL_USD` | The most one helper or data-source call may cost (default 0.25) | Default |

The `N8N_MCP_TOKEN` belongs to the n8n owner and can change anything on the instance, so it lives only in `studio.env` (mode 600). Studio's server is the only thing that holds it, and it passes the builder's calls on only through its guard rails (allow-listed tools, the agent's own workflow, approved steps and credentials; see the [plan](STUDIO_PLAN.md#guard-rails)). The platform wallet key is as sensitive: use a wallet that holds only test funds.

Things to know when it runs:

- **Starter credit** is sent from the platform wallet to the new agent's own wallet. When the platform wallet is low the agent is still created and the person is told it has no credit; top the wallet up and later agents get theirs. Look for `starter credit:` lines in `docker logs zynd-studio`.
- **A person's agents** are listings tagged `zynd-studio` plus a workflow in n8n's owner project, tagged `zynd-studio` and named `<agent> · <first 8 characters of the listing id>`. Deleting an agent in Studio archives the workflow and deletes the listing.
- **OpenAI spend** has no per-person meter yet: each person is limited to 30 builder messages an hour, and agents run on `AGENT_MODEL`. Set a usage limit on the OpenAI project.
- **Changing a live agent.** A change made by chat is saved as a newer version of the workflow; the live agent keeps running the earlier version until a test has passed, then Studio publishes the new one by itself. Publishing a workflow with a Zynd Trigger unbinds and rebinds its webhook, so a hire arriving in that moment can fail. If a change could not be put live, the person is told and `docker logs zynd-studio` has a `builder: could not put a change live:` line.
- **A server in preview mode** logs `studio: STUDIO_PREVIEW is on …` when it starts. On a live server that means the sample screens are being shown instead of the real ones: unset `STUDIO_PREVIEW` and restart.
- **The demo** has its own script and checklist: [STUDIO_DEMO.md](STUDIO_DEMO.md).
- **If an agent will not run** (the app says it "is not finished yet"), the workflow in n8n was changed outside Studio to something Studio does not allow (a Code step, another listing, another credential). Studio refuses to run or publish it until it is put right.

**Deploy.** `scripts/deploy/deploy.sh` builds and starts the `zynd-studio` container after the Gateway and n8n are healthy, only when `studio.env` exists. A Studio failure is reported and rolls Studio back to its previous image, and never fails the Gateway deploy. `studio` joins the `zynd-n8n-net` network, so `N8N_API_URL=http://zynd-n8n:5678` and `N8N_MCP_URL=http://zynd-n8n:5678/mcp-server/http` work from inside it; the Gateway is reached at its public `GATEWAY_URL`.

**Check.** `curl https://studio.thenorthbound.agency/api/health` answers `{"ok":true}`. `docker logs zynd-studio` shows setup failures as `sign-in setup failed at "identity" | "key" | "credential"`: `identity` = the Gateway or registry (check `STUDIO_SERVICE_TOKEN`, `AGENTDNS_WEBHOOK_SECRET`), `key` = the Gateway's API key route, `credential` = n8n (check `N8N_API_KEY`, `N8N_MCP_TOKEN`). Setup is safe to retry: a person signing in again resumes where it stopped.

**Rollback.** Redeploy an earlier commit, or `docker rm -f zynd-studio` (the Gateway and n8n do not notice). Studio keeps nothing: sign-in is Supabase's and agents are Gateway listings.
