# Zynd Studio

A web app for people who are not developers: sign in with Google, describe an agent in a chat, try it, publish it to the Zynd network. It runs on this repo's Gateway and n8n; users never see n8n, a key or a wallet. Plan, decisions and phases: [`docs/STUDIO_PLAN.md`](../../docs/STUDIO_PLAN.md).

**Status:** S0 (shell, screens, deploy files), S1 (Google sign-in and silent setup), S2 (the agent builder), S3 (chat with an agent, publish, pause, delete, activity) and S4 (change an agent by chat, plain-language errors, the [demo script](../../docs/STUDIO_DEMO.md)) are built and tested against stand-ins and the real n8n; they need an OpenAI key, a funded platform wallet and the server before a real run, and the demo has not been rehearsed on the live server (see the plan's "Still open"). Without the builder's settings, Create agent shows a plain "not switched on yet" note; in preview mode it plays a scripted build and a scripted change with sample data.

```
npm install                      # from the repo root (npm workspaces)
STUDIO_PREVIEW=1 npm run dev:studio   # http://localhost:3100, sample data, no sign-in
npm run lint:studio && npm run typecheck:studio && npm run test:studio && npm run build:studio
```

Settings are in [`.env.example`](.env.example). The Gateway needs `STUDIO_SERVICE_TOKEN` and `AGENTDNS_WEBHOOK_SECRET` set to accept Studio's setup call (`POST /internal/v1/provision`, [LLD](../../docs/LLD.md#dashboard--gateway-internal-api-g9)).

## Layout

| Path | What |
| --- | --- |
| `app/` | Pages (`sign-in`, `agents`, `agents/new`, `agents/[id]`), the auth routes (`auth/callback`, `auth/setup`, `auth/sign-out`) and `api/health` |
| `components/` | Screens' parts; `components/ui/` is shadcn/ui |
| `lib/copy.ts` | Every word the user reads, in one file. No "listing", "wallet", "workflow" or "n8n" |
| `lib/setup.ts` | First sign-in: Gateway provision → API key → Zynd credential in n8n. Idempotent |
| `lib/gateway/` | Session JWT and the `/internal/v1` client |
| `lib/n8n/` | n8n REST (create the credential) and a small MCP client |
| `lib/session*.ts`, `proxy.ts` | The Supabase session check and Studio's encrypted cookie |
| `lib/builder/` | The builder: OpenAI loop, its tools, `workflow-json.ts` (Studio writes the whole agent; the model only says what it is), `edit.ts` (turns "add this helper, change that instruction" into n8n's edit operations), `jobs.ts` (each message runs as a background job that a reload reattaches to), `events.ts` (the events and the one reducer the server and the browser share) |
| `lib/n8n/policy.ts`, `relay.ts` | What an agent's workflow may contain, and the guarded way Studio reaches n8n |
| `lib/sample.ts` | Sample data for preview mode |

Studio has no database. Sign-in is Supabase's; agents are Gateway listings tagged `zynd-studio`. Builder messages run as in-memory jobs in Studio's one process: a reload or a closed tab does not stop them, but a restart of Studio does (the screen then says the message was interrupted).

Do not run `npm run build:studio` while `npm run dev:studio` is running: both write to `apps/studio/.next`, and the dev server stops or reloads the page in a loop. If that happens, stop it, move `.next` aside and start it again.

## Preview mode

`STUDIO_PREVIEW=1` swaps in sample data and skips sign-in, and the top bar says so. It exists for the look sign-off on the live subdomain (S0) and for local work. Turn it off before real users arrive: it makes every page public. A production server that is in preview logs a warning when it starts (`instrumentation.ts`), and a louder one if the real settings are also present.
