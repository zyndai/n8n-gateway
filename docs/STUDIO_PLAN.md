# Zynd Studio — Plan

**Zynd Studio** (working name) is a web app for people who are not developers. They sign in with Google, describe an agent in a chat, try it, and publish it to the Zynd network, where other agents can hire it and pay it. Underneath, it reuses everything this repo already runs: the Gateway, `n8n-nodes-zynd` and the n8n instance. Users never see n8n, a key, a workflow or a wallet address.

The zynd.ai dashboard stays the tool for developers. Studio is a separate app in this repo.

This is a **simple MVP for a partnership demo**. The partnership decides whether it goes further, so everything here is the smallest version that works. Target: demo-ready one week after 2026-11-16.

| Doc | What it holds |
| --- | --- |
| [LLD › Dashboard → Gateway internal API](LLD.md#dashboard--gateway-internal-api-g9) | The `/internal/v1` routes Studio calls (listings, API keys, wallet, tasks, analytics) |
| [N8N_API](N8N_API.md) | The `/n8n/v1` contract the Zynd nodes use, including paying from an agent's own wallet |
| [MILESTONES](MILESTONES.md) | The Gateway and n8n package work this builds on |

---

## Decisions

Taken with the owner on 2026-11-16.

| Topic | Decision |
| --- | --- |
| Scope | A very simple MVP. Nothing is built that the demo doesn't need |
| Sign-in | zynd.ai accounts (the same Supabase project as the dashboard). **Google only.** None of the dashboard's setup steps (username, handle check, role) are shown |
| Identity | Each user gets **their own Zynd developer identity**, created silently at first sign-in with an automatic handle |
| AI | OpenAI, with a platform API key. The builder is an OpenAI model that drives the n8n MCP server from Studio's server. Agents use the platform's OpenAI credential in n8n |
| What gets built | **n8n workflows like the showcase ones** (Zynd Trigger → steps → answer), not n8n's built-in Agents, because only a workflow can be started by the Zynd Trigger and so be hired by other agents |
| Going live | An agent stays private until the user clicks **Publish** |
| Using an agent | A **chat box** on the agent's page |
| Money | When an agent is created, the platform sends it **starter credit** (test aUSD) from a platform wallet |
| What agents may use | OpenAI (platform key), hiring Zynd agents, AirnodeHub data, public web APIs that need no key |
| Where the code lives | This repo, as `apps/studio` (npm workspace), deployed on the Gateway server next to n8n |
| Look | Light theme, professional, built with shadcn/ui |

---

## What the user sees

1. **Sign in.** A card with "Continue with Google". After Google, the user lands straight on their agents. There is no setup page.
2. **Your agents.** Each agent is a card: name, one line on what it does, a **Draft**, **Live** or **Paused** badge, credit left and earnings. A **Create agent** button sits at the top. With no agents yet, the page shows three example ideas to click, such as "Check a new supplier before I pay them".
3. **Create agent.** The chat is on the left and a live preview card on the right. The preview fills in as the user talks: the agent's name, what it does, the helpers it uses (other agents and data sources, each with its price), and the cost per use. Building progress shows as a checklist: Finding helpers → Building → Testing → Ready.
4. **Agent page.**
   - **Chat:** use the agent. Each answer shows as readable text, with a line like "used 2 helpers · $0.08".
   - **Activity:** the user's own runs, and uses by other agents.
   - **Settings:** name, description, price per use, Pause, Delete.
   - **Publish** (top right): a dialog to confirm name, description and price per use, then the agent goes live.
5. **Account menu.** Name, total credit and sign out.

### Words

The UI uses plain words only. Technical detail sits behind one "Details" toggle.

| Never shown | Shown instead |
| --- | --- |
| listing, entity, zns id | agent |
| call agent, A2A | uses a helper |
| wallet, aUSD, USDC, tx hash | credit (in $) |
| ACTIVE / INACTIVE / heartbeat | Live / Paused |
| workflow, node, webhook, n8n, x402, API key | — |

---

## How it works

```
Browser ── Google sign-in (zynd.ai Supabase)
  │
  ▼
apps/studio  (Next.js, this repo, Gateway server)
  ├─ First sign-in ───► Gateway POST /internal/v1/provision   (new)
  │                     Gateway POST /internal/v1/api-keys
  │                     n8n REST API: the user's Zynd credential
  ├─ Builder chat ────► OpenAI (platform key) ⇄ Studio server ⇄ n8n MCP (allow-listed, owner-checked)
  ├─ Agent chat box ──► n8n MCP execute_workflow → get_workflow_execution
  ├─ Publish / pause ─► Gateway PATCH listing; n8n MCP publish / unpublish workflow
  └─ Agents, Activity ► Gateway listings, wallet, analytics, tasks; n8n executions

n8n (one instance, owner account): runs every user's agent workflow
  Zynd Trigger ◄── Gateway ◄── other agents (A2A + x402)
  AI step tools ──► Gateway ──► helpers (Zynd agents), AirnodeHub; public web APIs
```

### Flows

**1. First sign-in.**
1. Studio verifies the Supabase session and calls `POST /internal/v1/provision`. If the user already has a developer identity (for example from the dashboard), the Gateway returns it. Otherwise it creates one, using the same steps as the dashboard's `src/app/api/developer/register/route.ts`:
   - The registry's `POST /v1/admin/developers/approve` returns the developer id and key.
   - The key is re-encrypted under `PKI_ENCRYPTION_KEY` and a `developer_keys` row is inserted. The name comes from Google; the role is empty.
   - An automatic handle is claimed, then verified.
2. Studio mints a Session JWT for that developer and creates an API key (`search`, `call`, `complete`, with a spend cap).
3. Studio creates a `zyndApi` credential in n8n through n8n's REST API (the MCP server cannot create credentials). It holds the Gateway URL, the key and a random webhook secret, and is named `Zynd · <handle>`.
4. Steps 2 and 3 are skipped when the credential already exists.

**2. Create an agent.**
1. **Create agent** makes a DRAFT listing tagged `zynd-studio`. This gives the agent its id and its wallet.
2. Studio sends starter credit to that wallet.
3. The builder chat starts. The model asks at most three plain questions, finds helpers, and fills in the preview card. It then builds the workflow from the [template](#agent-workflow-template) through MCP, validates it and runs one test.
4. Studio saves the workflow id on the listing (`workflowId`). The builder says "Ready" only after a test run has answered.

**3. Use it in the app.**
1. The chat box calls `execute_workflow` through the template's chat trigger: `manual` mode for a draft, `production` mode once live. It then polls `get_workflow_execution`.
2. The answer comes from the workflow's last step. The helpers used and their costs come from the AI step's intermediate steps: the Zynd call results carry `paymentUsd`, and AirnodeHub results carry `payment.amountUsd`.
3. Each message is one run. The previous few turns are included in the request so that follow-up questions work.

**4. Publish.**
1. The dialog saves name, description (200 characters at most, AgentDNS's limit), category and price (`PATCH /internal/v1/listings/:id`).
2. Studio then calls `publish_workflow`. When the workflow turns on, the Zynd Trigger binds its webhook, and the Gateway registers the listing on AgentDNS and starts the heartbeat. This is the flow that already exists.
3. Name and description should be final first: AgentDNS keeps the values from the first registration.

**5. Hired by another agent.** Another agent calls the listing through the Gateway and pays its price. The Zynd Trigger runs the same path and the answer goes back synchronously (`responseMode = lastNode`). The earning lands in the agent's wallet. This is the flow that already exists.

**6. Edit, pause, delete.**
- **Edit:** the **Make changes** tab → `get_agent_setup`, then `edit_agent` (applied as one `update_workflow`) → a test run → Studio republishes if the agent is live and the test passed. Until then the live agent keeps its earlier version.
- **Pause:** `unpublish_workflow`. The trigger unbinds and the heartbeat stops.
- **Delete:** pause, archive the workflow, then `DELETE /internal/v1/listings/:id`. The dialog warns that any credit left is lost.

### Where state lives

Studio adds **no database tables**.

| What | Where it already lives |
| --- | --- |
| Sign-in | Supabase (zynd.ai project) |
| Developer identity | `developer_keys` (a row is written by the new Gateway route, never migrated) |
| The user's agents | Gateway listings with the `zynd-studio` tag; `workflowId` links each to its n8n workflow |
| Credit and earnings | Gateway `/internal/v1/wallet` and `/internal/v1/analytics` |
| Uses by other agents | Gateway `/internal/v1/tasks` |
| In-app runs | n8n executions |
| Builder conversation | OpenAI's stored responses (`previous_response_id`); the browser keeps the id per agent |
| Session | Studio's encrypted cookie holds the developer id and handle, checked against the Supabase session on every request |

### Agent workflow template

Every agent starts from one template, built from the Counterparty Check workflow. The builder fills it in and may add plain steps, but keeps its shape.

```
Zynd Trigger (this listing, responseMode lastNode) ─┐
Chat Trigger (in-app runs) ─────────────────────────┴─► Request (Set: one text field) ─► AI step ─► Answer (Set: { output })

AI step = AI Agent node, "return intermediate steps" on
  model: OpenAI Chat Model, platform credential
  tools: Zynd "use helper" ×N   callAgent, helper fixed, pay from this agent's wallet, max price per call
         AirnodeHub ×M          source and operation fixed, parameters filled by the AI, pay from this agent's wallet
         HTTP Request tool      public web APIs that need no key
```

Known n8n pitfalls go into the builder's instructions:
- n8n's expression sandbox refuses a field named `caller`, which the Zynd job has. Read `input` only.
- Summaries must be 200 characters or less.
- The Request step must accept both trigger shapes: `chatInput` from the chat trigger and `input` from the Zynd job.

### Guard rails

The n8n MCP token belongs to the instance owner and can change anything, including the showcase workflows. It stays on Studio's server, and Studio passes calls on only under these rules:

| Rule | How |
| --- | --- |
| Allow-listed MCP tools only | The builder model gets `search_nodes`, `get_node_types`, `get_workflow_sdk_reference`, `get_workflow_best_practices`, `validate_workflow`, `create_workflow_from_code`, `update_workflow` and `get_workflow_details`, each with only the arguments it needs (no workflow id, no project or folder). Studio's own code, never the model, calls `execute_workflow` (a chat run), `get_workflow_execution` (and keeps only the answer, helpers and cost), `search_workflow_executions`, `publish_workflow`, `unpublish_workflow` and `archive_workflow`. Credential, data-table and Agent tools, `test_workflow` and `prepare_workflow_pin_data` are not used at all. For changes to an existing agent the model calls Studio's own `edit_agent`, which writes the operations itself (and refuses a helper over the price cap or a tool the agent does not have); the relay then applies and checks them like any other update. Text that other agents publish about themselves (name, summary) is cut to one plain line with no `{{ }}` or leading `=` before it reaches a tool description or prompt |
| The user's own workflow only | Any `workflowId` must equal the current agent's. `create_workflow_from_code` is allowed only while the agent has none |
| Approved nodes and credentials only | After every create or update, Studio reads the workflow back and refuses it unless every node is on the allow-list (the template's nodes plus Set, If, Switch, Merge, Filter, Think and Calculator tools, Structured Output Parser) and every credential is the user's Zynd credential or the platform OpenAI credential. Code, Execute Command, SSH and file nodes are never allowed. The Zynd Trigger must point at this agent's listing |
| Limited spend | Starter credit only for a user's first three agents; a spend cap on each user's API key; a max price on every helper call |

### Look and screens

- **Stack:** Next.js (App Router), Tailwind, shadcn/ui, lucide icons, sonner for toasts.
- **Style:** light theme only, neutral greys (zinc), one accent colour (Zynd violet) for primary buttons and focus rings only, Inter, borders rather than heavy shadows, generous white space, skeleton loaders.
- **Layout:**
  - A top bar with the logo, "Agents" and the account menu.
  - Content up to 1200 px wide.
  - Pages that also work at phone width.
- **Screens:**
  - Sign in
  - Your agents (with an empty state)
  - Create agent
  - Agent page: Chat, Activity, Settings, and the Publish dialog
  - Account menu
- **Errors:** every error shows in plain words with a next step, for example "Your agent ran out of credit", "A helper didn't answer, try again" or "This took too long".

---

## Repo and deployment

```
apps/studio/                  Next.js app, its own package.json, tsconfig and lint
  app/sign-in, app/auth/callback
  app/agents, app/agents/new, app/agents/[id]
  app/api/…                   server-only route handlers
  components/ui/              shadcn components
  lib/supabase                session
  lib/gateway                 Session JWT + /internal/v1 client
  lib/n8n                     MCP client relay (+ guard rails) and the REST credential call
  lib/builder                 OpenAI loop, tools, template, instructions
  lib/credit                  starter-credit transfer (viem)
```

- **Repo tooling:**
  - The root `workspaces` gains `apps/*`.
  - The root eslint, vitest and `tsc` skip `apps/**`, as they already skip `packages/**`.
  - New root scripts: `dev:studio`, `build:studio`, `lint:studio`.
  - The Gateway bundle and its memory guard must not change.
- **Deployment:**
  - A `studio` target in the `Dockerfile` (Next.js standalone output).
  - A `studio` service in `docker-compose.yml`.
  - `scripts/deploy/deploy.sh` builds and restarts it.
  - A subdomain on the server's reverse proxy.

**Studio's environment:**
- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Gateway: `GATEWAY_URL`, `SESSION_JWT_SECRET`, `STUDIO_SERVICE_TOKEN`.
- n8n: `N8N_API_URL`, `N8N_API_KEY`, `N8N_MCP_URL`, `N8N_MCP_TOKEN`, `N8N_OPENAI_CREDENTIAL_ID`.
- OpenAI: `OPENAI_API_KEY`, `OPENAI_MODEL`.
- Registry: `AGENTDNS_URL`.
- Starter credit: `TREASURY_PRIVATE_KEY`, `X402_RPC_URL`, the aUSD address, `STARTER_CREDIT_USD` (1), `STARTER_CREDIT_MAX_AGENTS` (3).
- Agents: `AGENT_KEY_SPEND_CAP_USD` (5), `AGENT_MODEL` (the one model an agent may run on, default `gpt-5.4-mini`), `AGENT_MAX_CALL_USD` (0.25), `AIRNODE_SOURCES` (the AirnodeHub sources and operations the builder may offer).

### Changes to existing parts

| Part | Change |
| --- | --- |
| Gateway | One new route, `POST /internal/v1/provision`, authenticated with `STUDIO_SERVICE_TOKEN`. New env: `AGENTDNS_WEBHOOK_SECRET`, `STUDIO_SERVICE_TOKEN`. Nothing else |
| `n8n-nodes-zynd` | None |
| n8n | An API key for its REST API and an MCP token for Studio. Agent workflows land in the owner's personal project (team projects are not licensed) |
| Dashboard | None. A Studio user who opens the dashboard later already has a handle, so the setup page is skipped |
| Server | A new container, a subdomain and a reverse-proxy entry |

---

## What the owner provides

| Item | Used for | Needed by |
| --- | --- | --- |
| A subdomain pointed at the Gateway server (e.g. `studio.thenorthbound.agency`) | Hosting Studio | S0.4 |
| n8n REST API key and MCP token | Creating credentials; building and running workflows | S0.5 |
| Supabase URL and anon key of the zynd.ai project; Studio's callback URL added to the allowed redirect URLs | Google sign-in | S1.1 |
| `AGENTDNS_WEBHOOK_SECRET` (the dashboard's registry secret) | Creating developer identities | S1.2 |
| OpenAI API key | The builder. Agents keep using n8n's "OpenAI account" credential unless it should be switched to the new key | S2.2 |
| Platform wallet private key holding test aUSD and some Base Sepolia ETH | Starter credit | S2.1 |

---

## Status

As of 2026-11-16. **S0 to S4 are built and tested locally, except S4.4 (the rehearsal), which needs the live server; nothing is deployed yet.** What is left for each needs something only the owner has (a key, the server, a funded wallet): see [What the owner provides](#what-the-owner-provides). S2 to S4 are the phases that spend money and call OpenAI, so they have been exercised against stand-ins and against the real n8n, but not yet against a real OpenAI key or a funded platform wallet.

| Task | State | Evidence and what is open |
| --- | --- | --- |
| S0.1 Workspace | ✅ | `apps/studio` (Next.js 16, Tailwind 4, shadcn/ui, light theme). `npm run build:studio`, `lint:studio`, `typecheck:studio` and `test:studio` (30 tests when S0 was built, 241 after S3, 311 after S4) pass. Gateway lint, typecheck, 469 tests (one opt-in test skipped) and the build pass. The Gateway bundle grew 7 KB and its idle memory about 1.4 MB (82.1 → 83.5 MB; budget 85, peak 98 of 100); the budgets are unchanged |
| S0.2 Shell and tokens | ✅ | Top bar, 1200 px container, violet accent for primary buttons and focus only, Inter (self-hosted), all wording in `lib/copy.ts`. Checked at 1440 px and phone width |
| S0.3 All screens | ✅ built, ⏳ awaiting sign-off | Sign in, Agents (with the empty state and three ideas), Create agent (a scripted build in preview: chat, live preview card, checklist), agent page (Chat with a Details toggle, Activity, Settings), Publish dialog, delete confirmation, account menu. Run with `STUDIO_PREVIEW=1`; **awaiting the owner's sign-off on the look** |
| S0.4 Deploy files | ✅ written, ⏳ not deployed | `studio` Docker target (tested: builds under Node 22 / npm 10, runs as non-root, healthy, 52 MiB idle, 306 MB image), compose service, an optional and non-fatal `deploy_studio` step in `deploy.sh` (skipped until `studio.env` exists), a reverse-proxy snippet in the [runbook](RUNBOOK.md#zynd-studio), and `studio-ci.yml`. Open: the subdomain, `studio.env`, and the first deploy |
| S0.5 Assumptions | partly answered | [Answers below](#s05-answers) |
| S1.1 Google sign-in | ✅ code, ⏳ real Google run | Callback, protected pages, sign-out, `proxy.ts` session refresh. Exercised in the real Next.js runtime with a fake Supabase (cookie checks, redirects, open-redirect refusal). Open: the Supabase URL and anon key, and the callback URL in the project's redirect list |
| S1.2 `POST /internal/v1/provision` | ✅ against a fake registry, ⏳ real registry run | `ProvisionService` + `DeveloperStore`. 23 unit tests against a fake registry (signed handle claim verified), 4 Postgres tests including two Gateway instances racing, and the doc in [LLD](LLD.md#dashboard--gateway-internal-api-g9). Open: `AGENTDNS_WEBHOOK_SECRET` and `STUDIO_SERVICE_TOKEN` in the server's `.env`, and one real run against the registry (the fake mirrors the agent-dns source, but it is a fake) |
| S1.3 First-sign-in setup | ✅ against a stand-in n8n, ⏳ real n8n run | `lib/setup.ts` against the real Gateway app over HTTP (`test/studio.setup.test.ts`, 14 tests): signing in twice, or twice at once, creates one developer, one key and one credential; a failed credential revokes its key; the key in the credential works on `/n8n/v1`. Open: a real run against n8n's REST API (needs the API key; see S0.5 c) |
| S1.4 Account menu | ✅ code, ⏳ real balance | Name, email, total credit (the sum of the agents' wallet balances; a dash when the chain cannot be read), sign out. The balance can only be checked for real once an agent exists (S2.1); a new account has none |
| S2.1 Create agent and starter credit | ✅ against the real Gateway, ⏳ real wallet | `AgentService.create`: a DRAFT listing tagged `zynd-studio`, then `lib/credit/starter` sends test aUSD to the agent's own wallet address (read from the Gateway's wallet view). First three agents only, skipped (not an error) when the platform wallet is low or unset, one at a time per process. The transfer itself is tested through viem against a fake chain (decoded calldata: right token, right recipient, exact amount); the flow against the real Gateway app. Open: a funded `TREASURY_PRIVATE_KEY` and one real transfer on Base Sepolia |
| S2.2 Builder loop | ✅ against a scripted model, ⏳ real OpenAI | `lib/openai.ts` (Responses API, streamed, raw fetch, tested with the stream cut at awkward sizes), `lib/builder/loop.ts` (tool calls one at a time, continued by `previous_response_id`, stops at 16 turns with a final tool-less turn so the conversation stays continuable) and `build.ts` (a signed thread token per person and agent; 30 messages an hour; one message at a time per agent). Replies stream to the browser as one JSON event per line; the chat and preview come back after a reload from the browser's own storage. The key and model are set and were run through this loop (see S0.5 f); open: a real build with the real n8n and helpers |
| S2.3 Guard rails | ✅ | `lib/n8n/policy.ts` and `relay.ts`. Tests refuse: another workflow's id, a second create, a Code (and Execute Command, SSH, file, database, plain HTTP, non-tool Zynd) step, another person's Zynd credential, any non-platform OpenAI credential, any other credential type, a trigger bound to another listing, a public chat link, an error workflow, a helper that pays from the developer or another wallet, a helper chosen by an expression, a missing or over-cap price, a data source that is not offered, a non-GET or keyed or internal-address web tool, another model, and built-in model tools. A workflow with anything unallowed is archived at once on create and never run or published (checked again right before each run and publish). Proven against a real read-back of a workflow built from the template. Mutating the guards makes these tests fail |
| S2.4 Builder tools | ✅ | `find_helpers` (registry search; the price comes from each agent's public card, fetched without redirects and never from an internal address), `list_data_sources` (from `AIRNODE_SOURCES`), `update_preview` (only helpers the search returned; Studio adds the cost up itself; saves name, description and price on the listing), `get_template`, `test_agent`, `progress`. The model gets the n8n tools through the relay only |
| S2.5 Template and instructions | ✅ real n8n, ⏳ a real build | `lib/builder/template.ts` renders the Workflow SDK code with every id injected. Validated by n8n's own `validate_workflow`; created, **run through the Chat Trigger on the real n8n (execution 39: the AI step called the web tool, answered in 9 s)** and read back; a test executes the rendered code against stand-ins and requires the policy to accept it. The instructions are in `lib/builder/instructions.ts`. Open: the exit gate itself ("Check a new supplier before I pay them" yields a draft using Counterparty Check and Wallet Risk Screener) needs the OpenAI key |
| S2.6 Test before Ready | ✅ | `progress("ready")` is refused by Studio until `test_agent` has returned an answer from the Answer step since the last change to the workflow; a failed run tells the model why in plain classes (out of credit, helper did not answer, too long) and it is never shown as ready. At most four test runs a turn, since each can spend credit |
| S3.1 Chat box | ✅ real n8n, ⏳ with paid helpers | Start-and-poll (`POST /runs`, `GET /runs/<id>`, 300 s cap), so no request is held open. A draft runs in `manual` mode, a live agent in `production` mode, falling back to `manual` if n8n says it has no published version. The answer, "used N helpers · $x" and the details lines are read from the run (Zynd `paymentUsd`, AirnodeHub `payment.amountUsd`); raw execution data never reaches the browser. The last four turns go along for follow-ups. Open: a run that really pays a helper (needs funded wallets) |
| S3.2 My agents | ✅ | The Agents page reads listings, the wallet view and the analytics totals: Draft / Live / Paused, credit, earnings (settled payments over the last year) |
| S3.3 Publish | ✅ against the real Gateway, ⏳ real n8n trigger | The dialog saves name, description and price, Studio checks the workflow, publishes it, then activates the listing and waits for it to be live; if the registry or n8n refuses, the workflow is turned back off, never left half-live. Tested end to end against the real Gateway app and the fake registry (registered with the saved name and summary; pause, publish again keeps the same identity and registers once). Publish, unpublish and archive were run for real on n8n (production mode check). Open: the exit gate "another account's agent can hire it" and the Zynd Trigger binding on the real server |
| S3.4 Activity | ✅ | The person's tries (in-app runs, with the question, cost and result) and uses by other agents (Gateway tasks: only status and payment, never input, output, errors or the other agent's id), newest first |
| S3.5 Settings | ✅ | Save, Pause (workflow off, listing paused), Delete (pause, archive, delete; tolerant of a workflow already gone). The dialog names the credit that is lost |
| S4.1 Edit by chat | ✅ real n8n, ⏳ a real build | A **Make changes** tab on the agent page (any built agent). The builder gets two Studio-owned tools: `get_agent_setup` (what it does and its tools, no ids) and `edit_agent` (new instructions, helpers or data sources to add, tools to remove, web on or off). `lib/builder/edit.ts` writes the n8n operations itself (credential ids, payment limits, `$fromAI` text, how a tool plugs into the AI step) and rewrites the AI step's system message to match the tools it really has, so the model never hand-writes them. The relay applies them atomically, reads the workflow back and runs the policy. **Live agents:** a change is saved as a newer version; the live agent keeps running the earlier one. After the message, Studio publishes the new version only if a test has answered since the last change; otherwise it leaves the live version alone and says so in the chat (`updated`, `held` or `failed`). Checked on the real n8n (2026-11-16): the planned operations were accepted and stored exactly as written (execution 41: the edited agent, with three new tools, answered in 5 s); after an update to a published workflow `versionId` differs from `activeVersionId` while a production run still serves the old version (execution 42: "version one"); publishing again moves `activeVersionId` to the newest. Both throwaway workflows were archived. Open: an edit to a real published Studio agent (the Zynd Trigger unbinds and rebinds its webhook when republished: a hire in that moment can fail), and the model choosing good edits (needs the OpenAI key) |
| S4.2 Plain errors | ✅ | A page that cannot load shows `error.tsx` / `global-error.tsx` (plain words and **Try again**), and an outage on the agent page is no longer shown as "that page does not exist". Activity that cannot be read says so instead of "Nothing here yet". A dropped connection reads "We could not reach Studio…" and a builder stream that stops without finishing reads "This was interrupted…" (before, the first showed the browser's own "Failed to fetch" and the second nothing). A service being down has its own message; out of credit now says what to do (there are no top-ups yet). `test/copy.test.ts` fails if any string in `lib/copy.ts` uses a technical word (listing, wallet, workflow, n8n, x402, API key, token, JSON, gateway…), if an error code has no plain message, if a server message could pass through, or if a screen prints an error's own message |
| S4.3 Demo script | ✅ written, ⏳ not rehearsed | [STUDIO_DEMO.md](STUDIO_DEMO.md): checklist, seven acts, a table for what goes wrong, clean-up between runs, and an empty rehearsal log. Only two timings are measured (a chat run without paid helpers, 5 to 9 s); the rest are targets, marked as such |
| S4.4 Rehearsal | ⬜ needs the server | Two runs in a row on the live server, without touching n8n or a terminal. Needs everything under "Needs the owner" |
| S5.0 Credential fix | ✅ real n8n | Every real build failed: n8n's create-from-code gave the Zynd steps the first `zyndApi` credential it found, and the guard archived the workflow. The relay now sets both credentials itself (`credentialFixes`, `pinCredentials`) after every create or update, before the check. The REST-vs-MCP spike is under "n8n findings for S5" |
| S5.1 Studio writes the agent | ✅ real n8n, ⏳ the 90% eval (S5.4) | The model no longer writes workflow code or raw n8n operations: its tools are `find_helpers`, `list_data_sources`, `update_preview`, **`build_agent`**, `get_agent_setup`, `edit_agent`, `test_agent`, `progress`. `build_agent` takes what the agent is (instructions, helpers, data sources, web) and Studio renders the whole workflow as JSON (`lib/builder/workflow-json.ts`, sharing the tool-step builders with `edit.ts`), checks it **before** writing, writes it with n8n's REST API (create, or replace with `publishIfActive=false`, keeping n8n's ids so a live trigger keeps its webhook), sets credentials, reads it back and checks again. A helper's input type comes from its agent card (`inputModes`) when the card says. **Repairs by Studio:** a helper that did not answer is switched to the other input type and tested again; if the agent still gives no answer, the helper is left out and the agent tested once more; the model is told what changed. **Before the first test** an agent whose wallet cannot pay its cheapest tool is not run. Turns 16 → 10, test wait 150 → 240 s. One `builder.outcome` JSON line per message in the server log (outcome, cause, turns, tests, repairs, seconds). Checked on the real n8n (2026-11-17): a rendered agent created over REST passed the read-back check with both credentials right and answered its chat test; archived after |
| S5.2 Background builds | ✅ live, local | A builder message is a job in Studio's process (`lib/builder/jobs.ts`): one per person and agent, numbered events, a view built by the same pure reducer the browser uses (`applyEvent` in `events.ts`), kept 30 minutes after it ends, stopped after 8 minutes. `POST /build` starts it and streams it (job id in `X-Build-Job`); `GET /build` gives the latest job as a snapshot, `GET /build?after=n` the events after `n` then live ones (a ping every 15 s); `DELETE /build` stops it (a **Stop** button). The screen asks for the snapshot on arrival, reattaches to a running job, picks a dropped stream up again with back-off, and shows a job that ended while it was away. **Limit:** in memory, so a Studio restart loses running jobs (the screen then says the message was interrupted); Studio runs as one container. Checked locally against the real services (2026-11-17): a reload 13 s into a build reattached with `?after=1` and the build ended `ready` (8 turns, 1 test, 39 s) |

**Exit gates.** S0 needs the owner's sign-off on the look and an answer for every S0.5 check; (e), (g) and the REST half of (c) are still open. S1: reproduced locally with a fake Supabase, fake n8n and fake registry around the real Gateway: a new Google user lands on an empty Agents page; its developer, key and credential exist; signing in again changes nothing. Not yet shown with real Google, Supabase and n8n.

**S4 exit gate:** not shown. It is a rehearsal on the live server (S4.4). The script and the log for it exist.

**S2 and S3 exit gates, honestly.** S2 ("three different ideas each become a working draft with no manual help") and S3 ("user A publishes an agent; user B's agent hires and pays it; A sees the earning") are **not yet shown**: they need a real OpenAI key, a funded platform wallet and the server. What is shown: every step in between runs, against the real Gateway app (create, wallet, credit address, publish, pause, publish again, delete, tasks, earnings), against the real n8n (the template builds, validates and answers a chat run in draft and in production mode; publish, unpublish and archive work), and against a scripted model that builds an agent end to end through the guard rails. The three-ideas run is the first thing to do once `OPENAI_API_KEY` exists.

### Still open

Tick these off here as they are done. Nothing below is a known bug; each is either waiting on something only the owner or the server has, or a deliberate gap left for a later phase.

**Needs the owner (S2 and S3)**

- [x] `OPENAI_API_KEY`, `OPENAI_MODEL` (`gpt-5.4-mini`) and `N8N_OPENAI_CREDENTIAL_ID` (`cfxAkDUTr1FTbJ1u`): in `apps/studio/.env` (2026-11-16); Studio's loader reports the builder configured. Copy them to the server's `studio.env`. *(S2.2)*
- [x] **The agents' model (`AGENT_MODEL`) is `gpt-5.4-mini`** (decided 2026-11-16; now the code default and in `apps/studio/.env`). OpenAI marks the old default `gpt-5-mini` deprecated. Run through n8n with the template and the web tool, `gpt-5.4-mini` answered 2 of 2 questions correctly with one tool call each in 5 to 8 s, and gave the right page title where `gpt-5-mini` did not (the page reader strips the `<title>` tag, so either can miss it). It costs about three times `gpt-5-mini` per token ($0.75 / $4.50 against $0.25 / $2.00 per 1M), which is the price of each use of an agent: watch it once real usage exists. Copy `AGENT_MODEL` to the server's `studio.env`.
- [ ] `TREASURY_PRIVATE_KEY`: *generated 2026-11-16, in `apps/studio/.env`; address `0xD6E8c47A6594c5c7D042694ead1E05e3291B0ef1`. **Not funded yet:** it needs test aUSD (AirnodeHub USD, `0xbeA34973e5f67F18F656A2C6070C64326C791808`) and a little Base Sepolia ETH (chain 84532). Copy the key to the server's `studio.env`.* *(S2.1)*
- [ ] `AIRNODE_SOURCES`: which AirnodeHub operations the builder may offer (a JSON list; an example is in `apps/studio/.env.example`). Unset = no data sources. *(S2.4)*
- [ ] The three-ideas run (S2 exit gate) and the two-account hire (S3 exit gate), once the items above exist and the server runs Studio. Watch the OpenAI key's usage and the platform wallet while doing it.
- [ ] The rehearsal (S4.4): two runs of [STUDIO_DEMO.md](STUDIO_DEMO.md) in a row on the live server, filling in its log. It also answers what the script cannot yet: how long the registry takes to show a new agent, and what a change to a live agent does to a hire that arrives during the republish. *(S4.1, S4.4)*

**Needs the owner (S0 and S1)**

- [ ] Sign off the look (run with `STUDIO_PREVIEW=1`). This is S0's exit gate. *(S0.3)*
- [ ] A subdomain, its reverse-proxy entry, and `/opt/zynd-n8n-gateway/studio.env`. *(S0.4)*
- [x] The n8n REST API key and the instance-level MCP token: both in `apps/studio/.env`, both accepted by the live n8n (2026-11-16). Copy them to the server's `studio.env`. *(S0.5 c, S1.3)*
- [ ] `{STUDIO_PUBLIC_URL}/auth/callback` added to the Supabase project's allowed redirect URLs. *The Supabase URL and anon key are in `apps/studio/.env`, and the project has Google sign-in enabled (checked 2026-11-16). Studio does not use the service-role key, so it is not in any file.* *(S0.5 e, S1.1)*
- [ ] Copy `AGENTDNS_WEBHOOK_SECRET` and `STUDIO_SERVICE_TOKEN` to the Gateway's **server** `.env`, then redeploy the Gateway. *Both are now in the repo's `.env` (2026-11-16), and the Gateway's config loader accepts them with provisioning enabled; `STUDIO_SERVICE_TOKEN` matches `apps/studio/.env`. The registry's search answers from this machine.* *(S1.2)*
- [ ] A decision on the Gateway memory margin, below. *(S0.1)*

**Needs the server or the real services (nothing left to build)**

- [ ] The first deploy of Studio, then `https://<subdomain>/api/health` and the shell served over https. `deploy_studio` in `deploy.sh` has been syntax-checked and its parts run by hand (image, container flags, health check), but the script itself has not run on the server. *(S0.4 exit gate)*
- [ ] GitHub Actions: the new `studio-ci.yml` and the changed root `npm ci` have not run on GitHub. The Dockerfile's `npm ci --workspace=…` line was tested locally under Docker's npm 10, not in CI. *(S0.1, S0.4)*
- [ ] The S0.5 checks not yet answered: (a) the Studio container reaches the MCP URL, and `production` mode runs a published workflow (S3); (c) the REST call creates a `zyndApi` credential in the real n8n (a community credential type may be refused); (d) AgentDNS search from the server; (e) Supabase accepts the callback; (f) the platform OpenAI key and `OPENAI_MODEL`; (g) memory on the server.
- [ ] One real run of `POST /internal/v1/provision` against the registry: approve, the signed handle claim, verify. *(S1.2)*
- [ ] The S1 exit gate with real Google, Supabase and n8n: a new account lands on an empty Agents page, its key and credential exist, and signing in again changes nothing. *(S1.1, S1.3)*
- [ ] The account menu's credit with a real balance, once an agent has a wallet. *(S1.4, after S2.1)*

**Known gaps and follow-ups**

- [ ] **Gateway memory margin.** Idle rose about 1.4 MB (82.1 → 83.5 MB, budget 85) and peak reached 98.7 MB (budget 100). It traces to the new provisioning code; stubbing that code restores the old figures, but no single cause was found (not crypto, ed25519, `normalize` or loading it lazily). Choices: raise the guard a little, or keep it and look again if CI trips.
- [x] **Controls that only work in preview.** *Fixed in S2 and S3.* With the builder's settings in place the Create agent chat, the agent chat, Publish, Save, Pause and Delete are real; without them they show "not switched on yet" (and in preview they stay scripted). Edit by chat on an existing agent: *done in S4.1*.
- [x] **Preview mode must be off for real users.** *Fixed in S4.2.* A production server in preview logs a warning at start (`instrumentation.ts`, `startupWarnings` in `lib/env.ts`), and a louder one when the real settings are also present. The pages stay public in preview, by design; the API stays off.
- [x] **Deep links.** *Fixed in S3.* `proxy.ts` now passes the asked-for path to the page shell, so setup leads back to `/agents/<id>`. Not exercised with a real Google session yet.
- [ ] **Credential repair.** If a user's n8n credential exists but its key was revoked later, setup leaves it as it is, because n8n's public API cannot update a credential. Users never see keys, so this is unlikely; a delete-and-recreate path would fix it.
- [ ] **A lost race leaves one unused registry developer.** When two Gateway instances provision the same new user at once, one registry developer ends up unused (documented in the LLD). The database keeps one row; there is no cleanup of the registry side.
- [ ] **Starter credit can be earned again.** It is given to a person's first three agents *as counted now*, so deleting an agent and making another can earn it again, bounded by a 30-second pause between credits and 10 agents at a time. Fine for a demo; a per-person count would need somewhere to keep it (a Studio table, or a mark on the Gateway side).
- [ ] **Limits are per process.** The builder's 30 messages an hour, one message at a time per agent, and the credit pause live in the Studio process's memory: a restart forgets them and a second Studio instance would not share them. One container today.
- [ ] **The web tool can be aimed at addresses the AI chooses.** The policy refuses a web tool written with a private address, but an address the AI fills in at run time is not checked (the plan's known risk). Those internal services need authentication; block private addresses before real users.
- [ ] **Activity titles for in-app tries** read each run from n8n (up to 10 reads per page view). Fine at demo scale.
- [ ] **A builder conversation lost mid-message.** If the browser closes while the builder is working, the work in n8n continues and the agent is saved, but the chat text of that message is lost and the thread token is not updated; the next message starts from the last complete one and the builder is told the agent already has a version.
- [ ] **`prepare_workflow_pin_data` and `test_workflow`** are not offered to the model (the plan listed them): a real manual run through `test_agent` replaces them, so the model cannot test without the cost it is told about. Easy to add.
- [ ] **Version control.** Everything is in the working tree on `main`: no branch, commit or PR yet. `.codex/` (a plaintext n8n token) is now in `.gitignore`.
- [ ] **A held change is not remembered.** A live agent's saved-but-not-live change is found again from n8n's own version fields, so a later message that passes a test puts it live. But the person is only told "still on the earlier version" in the message where it happened, and again after any later message that changes nothing; there is no badge on the agent page.
- [ ] **A failed republish may leave n8n in either state.** If `publish_workflow` fails halfway, the agent may be on the earlier version or briefly off. The person is told to send the change again; Studio does not check afterwards.
- [ ] **Edits start from the instructions Studio wrote.** `edit_agent` finds the person's own instructions inside the AI step's system message by its fixed lead-in and closing. A system message the model rewrote by hand with `update_workflow` and an expression is refused for tool changes unless new instructions come with it.

**Decisions taken while building S4** (small, and easy to change):

- **Studio writes the edit operations, not the model.** A model that hand-writes n8n operations has to get credential ids, payment limits and expression text right; one slip is a broken or unsafe agent. `edit_agent` takes a description of the change and builds the operations; `update_workflow` stays for plain extra steps.
- **Studio publishes a live agent's change, not the model, and only after a passing test.** The model still never calls anything that publishes. If the test did not pass, the live agent is left on its earlier version.
- **Editing keeps the owner's price.** `update_preview` on an agent that is already built saves the name and description only: the builder's suggested price applies to the first build.
- **"Make changes" shares the Create chat's conversation** (same stored thread per agent), so the builder remembers how it built the agent.
- **The builder component is reused** with an `editing` mode (progress list only; the agent's page already shows its name and description) rather than a second chat.
- **Outage is not "not found".** Pages that depend on the Gateway let a failure reach the error page; only an agent that is not in the person's list is a 404.
- **No new setting, table or package.** `instrumentation.ts` is Next's own start-up hook.

**Decisions taken while building S2 and S3** (small, and easy to change):

- **Create agent happens on the first message**, not when the page opens: opening or reloading a page must never create a listing or send credit. The address then becomes `/agents/new?agent=<id>`, which restores the chat.
- **The model never names a workflow id.** Its tools have no such argument; Studio injects the agent's own. The relay still refuses a foreign id if one is sent. The model also never calls `execute_workflow`, `get_workflow_execution` or anything that publishes: `test_agent` wraps the run and reads back only the answer, helpers and cost.
- **Studio decides "Ready"**, not the model, and prices come only from helpers the search returned.
- **Chat runs are start-and-poll** rather than one long request, so a reverse proxy's timeout cannot cut an answer.
- **Production mode works for a published chat-trigger workflow** and its executions are labelled `chat`; in-app tries are the executions of mode `chat` or `manual`, and uses by other agents come from the Gateway's tasks.
- **Tags and names.** Every Studio workflow is created under the name `<agent> · <listing id prefix>` and tagged `zynd-studio`, in the n8n owner's personal project.
- **Nodes.** Agents use the existing `CUSTOM.zyndTool` and `CUSTOM.zyndAirnodeTool` (n8n's tool variants of the Zynd nodes), so `n8n-nodes-zynd` did not change. The plain `CUSTOM.zynd`, `CUSTOM.zyndAirnode` and Code steps are not allowed in an agent.
- **Caps** (all in code, easy to change): 10 agents per person, 30 builder messages an hour, 16 model turns per message, 4 test runs per message, 8 AI iterations per run, $0.25 per helper call by default.
- **`viem`** was added to `apps/studio` for the one transfer; the Gateway does not use it.

**Decisions taken while building S0 and S1** (small, and easy to change):

- **Preview mode** (`STUDIO_PREVIEW=1`): sample data and no sign-in, with a banner. Needed so the look can be signed off on the live subdomain before S1's secrets exist. It makes every page public, so it must be off for real use.
- **Runtime settings.** The Supabase address and key reach the browser as props from the server, not as `NEXT_PUBLIC_*` build values, so one image serves any environment and `next build` needs no secrets.
- **Cookie key.** Studio's cookie is sealed with a key derived (HKDF) from `SESSION_JWT_SECRET`, so no extra secret is needed. Two extra optional settings were added: `STUDIO_PUBLIC_URL` (redirects behind the proxy) and `N8N_GATEWAY_URL` (the Gateway address n8n puts in the credential).
- **Credential lookup** uses MCP `list_credentials` by exact name, since the REST API has no list call. A key left without a credential (a crash between the two steps) is replaced by rotating it, not stacked. If a credential exists but its key was revoked later, setup does not repair it: n8n's public API cannot update a credential.
- **Not in S1:** the Create agent and agent-page controls act only in preview. Without it they show "not switched on yet", and Publish, Pause, Delete and Save do nothing (S2 to S4).

### S0.5 answers

| | Check | Answer |
| --- | --- | --- |
| a | n8n MCP reaches `execute_workflow` in manual mode on a **draft** through a Chat Trigger with `chatInput` | **Yes** (2026-11-16, execution 38 on n8n.thenorthbound.agency, from an MCP client; not from the server). A draft built in the template's shape (Chat Trigger → Set → AI Agent → Set) ran in 9 s. The Set step read `chatInput`. `status` and `lastNodeExecuted` are in the execution. *Still open:* that Studio's container reaches the MCP URL (needs the server). **`production` mode on a published workflow: Yes** (2026-11-16, execution 40 on a throwaway chat-trigger workflow, since archived): a run before publishing answers `has no published (active) version to execute` with no execution id (HTTP success, `status: "error"`); after publishing it runs, and the execution is labelled `mode: "chat"`. Studio handles both |
| b | `get_workflow_execution` returns the AI step's intermediate steps | **Yes**, with `includeData: true`. `AI step` → `main[0][0].json.intermediateSteps[]`, each with `action.tool`, `action.toolInput` and `observation`. **The observation is a JSON string** (`[{"response":"391"}]`), so Studio parses it to read `paymentUsd` / `payment.amountUsd`. The execution data also holds the full prompt, the model options and the OpenAI organisation id: Studio must pick `output` and `intermediateSteps` only (ask for `nodeNames: ["AI step"]`) and never pass raw execution data to the browser or the model |
| c | n8n's REST API creates a `zyndApi` credential; MCP `list_credentials` finds it | **Mostly.** `list_credentials` works. The REST API key is accepted (2026-11-16: `GET /api/v1/workflows` answers 200) and the REST API **knows the community type**: `GET /api/v1/credentials/schema/zyndApi` answers 200 with `apiKey` (required), `apiUrl`, `webhookSecret`, `allowedDomains`, `allowedHttpRequestDomains`. The create call itself has still not been run against the real n8n (it would leave a credential behind); the first real sign-in does it |
| d | AgentDNS search answers without a key | **Yes**, from this machine: `POST /v1/search` answered 200 in 0.6 s and found the live Counterparty Check (active); `GET /v1/handles/{h}/available` also answers without a key. Not yet tried from the server |
| e | Supabase accepts Studio's callback | **Open**: needs the Supabase URL and anon key and the redirect entry |
| f | The OpenAI key and model work | **Yes** (2026-11-16). The platform key works and lists 96 models. Builder model chosen by running Studio's real builder loop and tool layer (n8n and the helper search stubbed) on "Check a new supplier before I pay them": **`gpt-5.4-mini`** reached Ready 4 times out of 4 in 11 to 12 model calls, about 30 s and about $0.04 a build, with no tool errors, the template code submitted unchanged and no irrelevant helper picked. `gpt-5.6-luna` ($0.20 in / $1.20 out per 1M tokens, the cheapest) kept editing and re-testing after a passing test and reached Ready 1 time in 7 (a prompt line saying a passing test is enough did not change that); `gpt-5.6-terra` ($2 / $12) did the same and cost $0.19 to $0.45 a try; `gpt-5-mini` reached Ready but needed a second message. Prices are OpenAI's published standard rates per 1M tokens: gpt-5.4-mini $0.75 / $4.50. **`gpt-5-mini`, Studio's default `AGENT_MODEL`, is marked deprecated by OpenAI** (which points to the 5.6 family); it still works in n8n today. **Agents' model decided:** `gpt-5.4-mini` (see Still open). Open: a real build with the real n8n and real helpers |
| g | The server has memory to spare for Next.js | **Open**: needs the server. In a container the Studio image idles at 52 MiB and the deploy step caps it at 512 MB. The Gateway is capped at 384 MB and n8n at 1 GB |

n8n findings for S4 (2026-11-16): `get_workflow_details` carries `active`, `versionId` and `activeVersionId` (null while unpublished). After `update_workflow` on a published workflow, `versionId` moves ahead and `activeVersionId` stays; production runs keep serving the published version until `publish_workflow` is called again, which works on an already-active workflow. `update_workflow` accepts `addNode` with `credentials`, `addConnection` with `connectionType: "ai_tool"` and `setNodeParameter` with a JSON pointer such as `/options`, and stores them as written (`$fromAI` is kept in its two-argument form).

Other n8n findings for S2: creating a workflow with `newCredential('OpenAI account')` in the SDK code auto-assigned the existing credential of that name, so the builder does not need credential ids. **Corrected 2026-11-17:** that only held because there is one OpenAI credential. `create_workflow_from_code` ignores the name and attaches the first credential of the type (`newCredential('Zynd · <handle>')` got the showcase "Zynd account"), so the guard archived every real build as "a credential that does not belong to this agent". Studio now sets both credentials itself with `setNodeCredential` right after a create or update, before the check (`credentialFixes` in `lib/n8n/policy.ts`).

n8n findings for S5 (2026-11-17, REST API v1.1.1, throwaway workflows archived): (a) `POST /api/v1/workflows` with JSON nodes stores credentials exactly as given (`{id, name}`) and accepts `settings.availableInMCP: true`; (b) MCP `get_workflow_details` reads it back unchanged and `execute_workflow` runs it as a draft through the Chat Trigger (execution 48); (c) `PUT /api/v1/workflows/{id}?publishIfActive=false` on a published workflow moves `versionId` and leaves `activeVersionId` on the running version. REST cannot run a draft with a chat message (its `test-runs` are evaluations that need an Evaluation Trigger), so runs stay on MCP. Decision: Studio writes workflows through REST, runs and reads them through MCP. The Zynd Trigger still cannot be fired through MCP, as the showcase work found, so tests run through the Chat Trigger.

---

## Phases

| Phase | Goal | Exit gate |
| --- | --- | --- |
| [S0 — Foundations](#s0--foundations) | The app exists, looks right and runs on the server; the assumptions are checked | The owner signs off the look on the live subdomain; every S0.5 check has an answer |
| [S1 — Sign-in and silent setup](#s1--sign-in-and-silent-setup) | A Google sign-in becomes a Zynd identity, a key and an n8n credential, invisibly | A new Google account signs in and sees an empty Agents page; its identity, key and credential exist |
| [S2 — Agent builder](#s2--agent-builder) | Chat turns an idea into a tested draft agent | Three different ideas each become a working draft with no manual help |
| [S3 — Use, publish, my agents](#s3--use-publish-my-agents) | Agents can be used, published, paused and deleted from the app | User A publishes an agent; user B's agent hires and pays it; A sees the earning |
| [S4 — Edit by chat and demo readiness](#s4--edit-by-chat-and-demo-readiness) | Changes by chat, plain error handling, a rehearsed demo | The demo script ([STUDIO_DEMO.md](STUDIO_DEMO.md)) runs twice in a row on the live server without touching n8n or a terminal |
| [S5 — Reliable builds, in the background, shown live](#s5--reliable-builds-in-the-background-shown-live) | Builds that work, survive a reload, and show the agent taking shape | 27 of 30 eval ideas reach "ready", twice in a row |

### S0 — Foundations

State: ✅ done and tested · ⏳ built, part still open (see [Still open](#still-open)) · ⬜ not started. S2 and S3 below use the same marks; each ⏳ is waiting only on a key, a funded wallet or the server.

| ID | Task | Done when |
| --- | --- | --- |
| S0.1 ✅ | Add `apps/studio` as an npm workspace: Next.js, TypeScript, Tailwind, shadcn/ui initialised with the light theme. Root tooling skips `apps/**`; root scripts added | `npm run build:studio` passes; Gateway lint, typecheck, tests, bundle size and memory guard unchanged |
| S0.2 ✅ | App shell and design tokens: top bar, page container, type scale, shadcn base components, and one file holding all user-facing wording | The shell renders cleanly at desktop and phone width |
| S0.3 ⏳ | All screens with sample data: sign in, agents (and empty state), create agent (chat, preview card, checklist), agent page (Chat, Activity, Settings), Publish dialog, account menu | The owner signs off the look |
| S0.4 ⏳ | `studio` Docker target, compose service, `deploy.sh` step, reverse-proxy entry | The subdomain serves the shell over https |
| S0.5 ⏳ | Check assumptions from the server and record each answer here: (a) the server reaches n8n MCP, and `execute_workflow` in manual mode runs a **draft** workflow through a Chat Trigger with `chatInput`; (b) `get_workflow_execution` returns the AI step's intermediate steps; (c) n8n's REST API creates a `zyndApi` credential and MCP `list_credentials` finds it; (d) AgentDNS search answers from the server without a key; (e) Supabase accepts Studio's callback; (f) the OpenAI key and model work; (g) the server has memory to spare for a Next.js process | Each check is answered yes or no, with a workaround noted for any no |

### S1 — Sign-in and silent setup

| ID | Task | Done when |
| --- | --- | --- |
| S1.1 ⏳ | Google sign-in through the zynd.ai Supabase project, the callback, protected pages and sign-out | A zynd.ai Google account lands on Agents with no other screen in between |
| S1.2 ⏳ | Gateway `POST /internal/v1/provision` (`STUDIO_SERVICE_TOKEN`), body `{ userId, name }`. Idempotent: returns the existing developer, gives a handle to one that has none, or creates one with the dashboard's steps (registry approve, re-encrypt under `PKI_ENCRYPTION_KEY`, insert `developer_keys`, claim and verify the handle). Handle: a slug of the Google name plus 4 random characters, retried on a clash. Tests against the fake AgentDNS | A new user gets a developer row and a verified handle; an existing dashboard developer gets the same `developerId` back; calling twice creates nothing new |
| S1.3 ⏳ | Studio's first-sign-in step: provision → API key (`search`, `call`, `complete`, spend cap) → `zyndApi` credential in n8n named `Zynd · <handle>`. Skipped when the credential exists. The developer id and handle go in Studio's session cookie | Signing in twice creates exactly one key and one credential |
| S1.4 ⏳ | Account menu with the name, total credit across agents, and sign-out | The real balance shows |

### S2 — Agent builder

| ID | Task | Done when |
| --- | --- | --- |
| S2.1 ✅ | **Create agent** makes a DRAFT listing tagged `zynd-studio` and sends starter credit to its wallet from the platform wallet ($1, first three agents per user; skipped with a plain note if the platform wallet is low) | A new agent shows $1.00 of credit within a minute |
| S2.2 ⏳ | Builder loop: OpenAI Responses API with function tools, continued by `previous_response_id`, streamed to the browser | Replies stream, and the chat comes back after a page reload |
| S2.3 ✅ | MCP relay with the [guard rails](#guard-rails) | Tests show calls refused for another workflow's id, a Code node, a foreign credential and a trigger bound to another listing |
| S2.4 ✅ | Studio's own builder tools: `find_helpers` (AgentDNS search → helper cards with price), `list_data_sources` (from `AIRNODE_SOURCES`), `update_preview` (name, description ≤ 200, helpers, cost estimate, suggested price → listing and preview card), `progress` (the checklist) | The preview card and checklist update live while the builder works |
| S2.5 ⏳ | The template (Workflow SDK code based on Counterparty Check) and the builder's instructions: plain language, at most three questions, always start from the template, ids injected by Studio, the [known pitfalls](#agent-workflow-template) | "Check a new supplier before I pay them" yields a valid draft that uses Counterparty Check and Wallet Risk Screener |
| S2.6 ✅ | Test before Ready: the builder runs one sample through `execute_workflow` (manual) and says Ready only once it answers; on failure it fixes the workflow and tries again, then gives up with a plain message | A deliberately broken draft is either fixed or reported in plain words, never shown as Ready |

### S3 — Use, publish, my agents

| ID | Task | Done when |
| --- | --- | --- |
| S3.1 ⏳ | Agent chat box: `execute_workflow` (manual for a draft, production when live) through the chat trigger, polled to the end (300 s cap); shows the answer and "used N helpers · $x" from the intermediate steps; includes the last few turns for follow-ups | Answers appear; the helpers and cost shown match the payments made |
| S3.2 ✅ | Agents page from `zynd-studio` listings, the wallet and analytics: Draft / Live / Paused, credit, earnings | The page matches the Gateway's data for a user with three agents |
| S3.3 ⏳ | Publish dialog: confirm name, description and price → `PATCH` the listing → `publish_workflow` → Live | The agent shows up in AgentDNS search, and another account's agent can hire it |
| S3.4 ✅ | Activity tab: in-app runs (n8n executions of this workflow) and uses by other agents (Gateway tasks), in plain words | Both kinds of run show, newest first |
| S3.5 ✅ | Settings: edit name, description and price; Pause (`unpublish_workflow`); Delete (pause, archive, delete the listing) behind a confirmation that names any credit left | Each action works and is reflected on the Agents page |

### S4 — Edit by chat and demo readiness

| ID | Task | Done when |
| --- | --- | --- |
| S4.1 ✅ | Edit by chat on the agent page ("also check sanctions") → `update_workflow` → test run → republish if live | A live agent changes behaviour after one chat request, without going offline for more than a moment |
| S4.2 ✅ | Plain-language errors and empty states throughout: out of credit, helper failed, took too long, nothing here yet | No raw error text or code reaches the UI in the demo script |
| S4.3 ⏳ | Demo script: a fresh account rebuilds the due-diligence agent by chat, tries it, publishes it; a second account's agent hires it | The script is written down with expected timings (timings are targets until the rehearsal) |
| S4.4 ⬜ | Rehearsal on the live server: platform wallet topped up, showcase helpers live and funded, two demo accounts ready | The script runs twice in a row without touching n8n or a terminal |

### S5 — Reliable builds, in the background, shown live

| Step | What | Done when |
| --- | --- | --- |
| S5.0 ✅ | Studio sets agents' credentials itself; REST vs MCP spike | A real build is no longer archived for a foreign credential |
| S5.1 ✅ | `build_agent`: Studio renders and writes the whole agent (REST), repairs helpers that do not answer, checks credit before testing; the raw n8n tools leave the model's list | The model never writes workflow code; unit tests cover each repair |
| S5.2 ✅ | Builds run as background jobs: a reload or a closed tab does not stop them, and the screen reattaches | Reload mid-build: the progress picks up where it was and finishes |
| S5.3 | The agent's parts appear and come alive while it is built and tested, with a plain activity feed | "Working on it…" is gone; every step the builder takes shows |
| S5.4 | An eval of 30 fixed ideas against the real services | At least 27 of 30 reach "ready" on two runs in a row |

---

## Later, only if the partnership goes ahead

- Check n8n's licence: hosting workflows that outside users create, for money, may need n8n's Embed licence.
- Move identity creation into one place shared with the dashboard.
- Top-up with real money (the dashboard has Coinbase onramp notes); mainnet.
- Meter and cap each user's AI usage.
- Scheduled agents and form-with-approval agents (the Procurement Desk pattern).
- A Claude connector (MCP), so people can build and use agents from inside Claude.
- Slack and Telegram as places to use an agent.
- Block private addresses for the HTTP tool; n8n queue mode with workers; Studio's own tables for history.

## Risks

| Risk | Impact | Mitigation in the MVP |
| --- | --- | --- |
| The n8n MCP token can change anything on the instance | A model mistake could alter or delete other workflows, including the showcase | The token stays on the server; the allow-list, ownership and node checks above; publish and delete only from buttons |
| The AI builds a workflow that doesn't work | A bad demo | One template, validation, a required test run before Ready, retries |
| Starter credit drains the platform wallet | Hiring stops working | $1 × three agents per user, a spend cap per key, skip credit when the wallet is low |
| Identity creation duplicates the dashboard's logic | The two could drift | The same steps as the dashboard, with tests; to be unified later |
| One shared n8n for every user | One user's agent could affect others | Users never reach n8n; only approved nodes; no Code or Execute Command |
| The HTTP tool can reach internal addresses | Requests to services inside the server | Those services need authentication; private-address blocking later |
| OpenAI cost has no per-user cap | Unexpected bill | A usage limit on the OpenAI project |
| Test network only (aUSD on Base Sepolia) | Not real money | Fine for the demo; mainnet later |

## Not in the MVP

Real money, AI cost metering, schedules, forms, Slack or Telegram, a Claude connector, team accounts, Studio database tables, sign-in methods other than Google, languages other than English, dark mode.
