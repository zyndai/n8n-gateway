# Zynd Studio — demo script

The partnership demo, start to finish: a person who is not a developer builds an agent by chat, tries it, changes it, publishes it, and a second person's agent hires it and pays it. About 12 minutes on stage.

This is the script for [S4.3 and S4.4 of the plan](STUDIO_PLAN.md#s4--edit-by-chat-and-demo-readiness). **Nothing here has been rehearsed on the live server yet.** Every time below is a *target* unless it is marked *measured*. The two rehearsals fill in the [log at the end](#rehearsal-log), and the script gets corrected from it.

| Who | Role |
| --- | --- |
| **Ada** (presenter) | Account A. Builds, changes and publishes the agent |
| **Ben** | Account B. Builds an agent that hires Ada's. A second browser profile, on a second screen if there is one |

---

## Before you start

Check all of these on the day, in this order. If one fails, fix it before starting: none of them can be fixed live.

| # | Check | How you know |
| --- | --- | --- |
| 1 | Studio is up on its subdomain, and it is **not** in preview mode | `https://<subdomain>/api/health` answers `{"ok":true}`. The page has no "Preview with sample data" bar. The container log has no `STUDIO_PREVIEW is on` line |
| 2 | The platform wallet can pay starter credit | It holds at least $4 of test aUSD (one $1 credit per agent, a few rehearsal agents) and some Base Sepolia ETH for gas |
| 3 | The two showcase helpers are live and funded | Counterparty Check and Wallet Risk Screener show as active in AgentDNS search, and each still answers a call |
| 4 | The OpenAI key has a usage limit and credit | Set in the OpenAI project, not in Studio. A build can use a few model calls per message |
| 5 | Both Google accounts have signed in once | Their first sign-in takes a moment (it creates the developer identity, key and n8n access). Do it the day before so the demo's sign-in is the fast path |
| 6 | Both accounts start clean | Ada and Ben each have no demo agents left from a rehearsal (Settings → Delete), or fewer than three agents in total, so a new agent still gets starter credit |
| 7 | The data source for the change in Act 4 is on | `AIRNODE_SOURCES` lists Briefpixel news. If it does not, use the fallback change in Act 4 |
| 8 | Backup | A screen recording of a good run, and the browser zoomed so the back row can read it |

Where to look when a check fails: the [runbook](RUNBOOK.md#zynd-studio) and the container logs. Studio logs one line per failure and never prints a secret.

---

## The run

### Act 1 — Sign in (about 20 s)

**Say:** "This is for people who have never heard of an API. They sign in with Google and that is all the setup there is."

1. Ada opens the Studio address and clicks **Continue with Google**.
2. Expect: she lands on **Your agents**, empty, with three example ideas. No setup page, no keys.

### Act 2 — Build an agent by chat (target 90 s)

**Say:** "She says what she wants. Studio finds other agents on the Zynd network that can help, builds the agent, and tests it before saying it is ready."

1. Click the first idea, **Check a new supplier before I pay them**, then send it.
2. Watch the right side while it works: the card fills in (name, what it does, helpers and what each costs), and the progress list moves **Finding helpers → Building → Testing → Ready**.
3. Expect: the agent uses **Counterparty Check** ($0.05) and **Wallet Risk Screener** ($0.03), about **$0.08** per use. The builder asks at most three plain questions. If it asks one, answer: "Short verdict, and yes, mostly crypto."
4. Expect "Ready" only after the test run. Click **Open agent**.

Starter credit: a toast says the agent starts with $1.00.

### Act 3 — Try it (target 30 s)

**Say:** "Now she uses it, like any chat assistant. It says which helpers it hired and what that cost."

1. On the **Chat** tab send: *Check Johnson Matthey PLC and the wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 before I pay their invoice.*
2. Expect: a short plain-English verdict, and the line **"used 2 helpers · $0.08"**. Click **Details** to show each helper and its price.

*Measured:* a chat run on a built agent with no paid helper answered in 5 to 9 seconds (executions 39 and 41 on the real n8n). Two paid helpers add their own time; the target is under 30 s.

### Act 4 — Change it by chat (target 60 s)

**Say:** "She does not edit anything by hand. She says what is different."

1. Open **Make changes** and send: *Also look up recent news about the company.* (Fallback if Briefpixel news is not switched on: *Make the answer shorter: one paragraph, verdict first.*)
2. Expect: the progress list runs, then a line in the chat. The agent is not live yet, so it says nothing about going live.
3. Back on **Chat**, ask the same question again and show the difference.

### Act 5 — Publish (target 30 s)

**Say:** "Until she clicks Publish, nobody else can use it."

1. Click **Publish** (top right). The dialog shows the name, what it does (200 characters at most) and the price per use. Set the price to **$0.15** and confirm.
2. Expect: a toast, and the badge turns **Live**.

*Optional, only if the registry has shown the agent within a minute during rehearsal:* make a change by chat now, and point out that a tested change goes live by itself while the agent keeps answering. Do not do this unless the rehearsal showed it working.

### Act 6 — Another agent hires it (target 3 minutes)

**Say:** "Now someone else. Ben builds his own agent, and Ada's is one of the helpers he can hire."

1. On Ben's screen: sign in, **Create agent**, and send: *Check a supplier before I pay them, using Supplier Check.* (use the exact name Ada published).
2. Expect: the builder finds **Supplier Check** in its search and lists it with its price. **If the search does not find it, wait a minute and send the message again**: how long the registry takes to show a new agent is not yet known (see the rehearsal log).
3. Ben tries his agent in **Chat**. Expect "used 1 helper · $0.15" or more, depending on what he built.
4. Back on Ada's screen: **Activity** shows **Another agent hired it** with the earning, and her **Agents** page shows earned credit going up.

This act is the S3 exit gate and has never been run end to end. It is where the first rehearsal is most likely to teach us something.

### Act 7 — Close (about 30 s)

**Say:** "Two people, neither a developer, and their agents are now working together and paying each other, on the Zynd network."

Show Ada's **Settings**: **Pause agent** and **Delete agent** (do not click them on stage). Then clean up (below).

---

## If something goes wrong

Every message in Studio is plain words. Say what it says, then use this table.

| What the screen says | What happened | What to do |
| --- | --- | --- |
| "Your agent has run out of credit…" | The agent's $1 is spent (each rehearsal run costs about $0.08 plus helpers) | Create a fresh agent to get new starter credit; do not wait for a top-up, there is none yet |
| "A helper did not answer. Please try again." | A showcase helper is down or slow | Try once more. If it repeats, check the helper in AgentDNS before continuing |
| "This took too long. Please try again." | A run took more than five minutes | Try once more |
| "Studio is busy right now…" | OpenAI is rate limiting | Wait a minute; check the usage limit (check 4) |
| "The agent builder is not switched on yet." | Studio is missing a setting | Stop and check the server settings; this is not fixable live |
| The builder says it could not finish | Three build attempts failed | Send the idea again, a little simpler. The agent is saved either way |
| Act 6 finds no "Supplier Check" | The registry has not shown it yet | Wait and resend. As a fallback, have Ben hire Counterparty Check directly: the point (an agent hiring another) is the same |
| The page says "This page did not load" | The Gateway or n8n was unreachable | Press **Try again** |

---

## After each run

Do this before the next run, so each run starts as the first one:

1. Ada: **Settings → Delete agent** on every demo agent. Ben: the same.
2. Check the platform wallet balance (check 2). Starter credit is $1 per new agent, for a person's first three agents as counted *now*, with a 30-second pause between two credits.
3. Check the OpenAI usage for the run.

---

## Rehearsal log

Fill this in at each rehearsal on the live server (S4.4). The exit gate is two runs in a row, start to finish, without touching n8n or a terminal.

| | Target | Run 1 | Run 2 |
| --- | --- | --- | --- |
| Date, who | | | |
| Act 1: sign in | 20 s | | |
| Act 2: build to Ready | 90 s | | |
| Act 3: first answer | 30 s | | |
| Act 4: change, test, done | 60 s | | |
| Act 5: Publish to Live | 30 s | | |
| Act 6: Ben's search finds Supplier Check after | not known yet | | |
| Act 6: Ben's answer | not known yet | | |
| Act 6: Ada sees the earning after | not known yet | | |
| Platform wallet spent (aUSD) | | | |
| OpenAI cost | | | |
| Anything that needed n8n or a terminal | none | | |
| Anything the screen said that a non-developer could not follow | none | | |
