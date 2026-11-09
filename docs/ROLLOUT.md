# Zynd n8n Integration — Rollout Plan

## Milestones

| Milestone | Duration | Deliverables | Gate |
| --- | --- | --- | --- |
| M0 — Scaffold | Week 1 | Gateway repo: Express skeleton, Drizzle schema, CI. n8n package repo: `tsc` build, CI, empty node shells | Both repos build green |
| M1 — Identity + heartbeat | Week 2 | IdentityService, HeartbeatManager, registration endpoint, integration test against AgentDNS staging | Agent registered and heartbeat visible in search |
| M2 — A2A + x402 | Week 3 | A2AHandler, PaymentProcessor, WebhookForwarder, end-to-end task flow | One paid call completes through Gateway to n8n and back |
| M3 — n8n nodes + publish | Week 4 | Zynd.node.ts (all ops), ZyndTrigger.node.ts, ZyndApi credential. Pass scanner. `npm publish --provenance`. Submit to Creator Portal | Package on npm, scanner passes, submission filed |
| M4 — Dashboard panel | Week 5 | n8n panel pages, dashboard API routes, wired to Gateway | Developer can create listing, generate key, see agent go live |
| M5 — Beta + launch | Week 6 | Invite 5 beta builders, fix issues, write setup guide, announce | All beta builders have at least one live agent on n8n |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| n8n scanner rejects package | Medium | Blocks publish | Run `npx @n8n/scan-community-package` in CI from day 1 |
| Verification review takes weeks | High | Delays marketplace listing | Submit early at M3; unverified installs still work self-hosted |
| Heartbeat WebSocket drops under load | Low | Agents go inactive | Reconnect with backoff; monitor fail rate; horizontal scale |
| Gateway single point of failure | Medium | All n8n agents offline | Health checks, auto-restart, add second instance at M5 |
| Key decryption adds latency | Low | Slow first call | Cache derived keypairs in memory per listing; invalidate on rotation |

## Launch Checklist

### Before beta (end of M4)

- [ ] Gateway deployed to staging, health endpoint returning 200
- [ ] At least one n8n workflow receives a paid call end-to-end on staging
- [ ] `npx @n8n/scan-community-package` passes with zero issues
- [ ] npm package published with `--provenance`
- [ ] Dashboard n8n panel accessible behind auth
- [ ] API key creation flow: create, display once, mask thereafter
- [ ] Listing activation flow: create → register → heartbeat → searchable
- [ ] Error messages display correctly in n8n UI for all error codes
- [ ] No `console.log` in n8n package
- [ ] Zero runtime `dependencies` in `package.json`

### Before launch (end of M5)

- [ ] 5 beta builders tested; critical feedback addressed
- [ ] Gateway monitoring: uptime, heartbeat count, error rate, p99 latency
- [ ] Rate limiting on `/n8n/v1/*` endpoints per API key
- [ ] Spend cap enforcement tested with real x402 payments
- [ ] Setup guide published: Dashboard → API key → `npm install` → add credential → build workflow
- [ ] n8n Creator Portal submission accepted or timeline confirmed
- [ ] Rollback plan documented: Gateway reverts independently of dashboard
- [ ] Dashboard "Get n8n Nodes" link updated from old GitHub repo to npm install command
