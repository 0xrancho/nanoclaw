# NanoClaw Progress Log

Host-level changelog tracking significant work on the NanoClaw system.

---

## 2026-03-10 — Managed Conversation Upstream Channel (Fixed)

### Problem
Managed conversation containers (`managed:*`) had no working output path. Four consecutive test runs crashed with `error_during_execution` — every attempt was a new random fix without diagnosing the root cause.

### Root Causes (Three Layers)
1. **Stale compiled code**: Host `dist/index.js` and container `agent-runner/dist/index.js` were never recompiled after adding `isManaged` session-skip and Gmail MCP stripping. Every test run passed a stale session ID → SDK crashed on resume with mismatched MCP config.
2. **No text output captured**: After fixing the crash, the agent called `report_to_main` (worked) but produced `result: null` — no email reply sent. The agent-runner only captured text from SDK `result` messages. When the agent's last action is a tool call, `result.result` is null. The actual text was in `assistant` messages, never captured.
3. **Contradictory prompt**: Global CLAUDE.md told managed containers they had Gmail tools. They don't. The agent saw conflicting instructions and didn't produce text output for the email reply.

### Fixes
- **Agent-runner text capture** (`container/agent-runner/src/index.ts`): Accumulates text from `assistant` messages. Falls back to accumulated text when `result.result` is null.
- **Managed prompt override** (`container/agent-runner/src/index.ts`): Strips Gmail section from global CLAUDE.md for managed containers. Appends explicit routing instructions: streaming text = email reply, `report_to_main` = internal to Joel.
- **Gmail MCP stripped**: Managed containers don't get Gmail, Calendar, or Drive MCP servers (prevents direct email sends that bypass the reply pipeline).
- **Session skip**: Managed containers always start fresh sessions (each email is a fresh turn, no stale MCP config crashes).

### Feedback Loop (New Feature)
- **`inject_context` IPC tool** (`ipc-mcp-stdio.ts`): Main group only. Lets Thomas in main send feedback/context to any managed container.
- **IPC handler** (`src/ipc.ts`): Stores injected message in DB under the managed JID and triggers the message loop via `queue.enqueueMessageCheck()`.
- **Use case**: Joel sees report_to_main in Telegram, doesn't like the response, tells Thomas in main → Thomas calls `inject_context` → managed container receives feedback and adjusts.

### Verified Working
- Email from joelaustin.co@gmail.com → routed to `managed:test-report` → container started (fresh session, no Gmail MCP) → streaming text delivered as email reply → `report_to_main` delivered to Telegram. Both channels working.

### Files Changed
- `container/agent-runner/src/index.ts` — assistant text accumulation, managed prompt override, Gmail section stripping
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `inject_context` tool (main only)
- `src/ipc.ts` — `inject_context` handler, `injectMessage` dep
- `src/index.ts` — wired `injectMessage` (storeMessage + enqueueMessageCheck)
- `src/cli.ts`, `src/ipc-auth.test.ts` — added `injectMessage` to IpcDeps

---

## 2026-03-09 — Email OAuth Fix, Monitor Dashboard, Managed Conversation Routing

### Email OAuth Fix
- **Root cause**: GCP OAuth app (`thomas-bot-488621`) was in "Testing" mode. Google expires refresh tokens after 7 days in testing. Thomas's token expired, email polling failed with `invalid_grant` on every 30-second cycle.
- **Immediate fix**: Re-authorized all 3 accounts (thomas@commitimpact.com, joel@commitimpact.com, joelaustin.co@gmail.com) with full scopes (Gmail + Calendar + Drive).
- **Permanent fix**: Published the GCP app — refresh tokens no longer expire.
- **Backoff logic added** (`src/channels/email.ts`): Token refresh failures now use exponential backoff (1min → 30min cap) instead of retrying every 30 seconds. After 3 consecutive failures, sends a one-time Telegram alert. On backoff expiry, reloads credentials from disk so externally-refreshed tokens are picked up without restart.

### Standalone Monitor Dashboard
- **New file**: `src/monitor.ts` — standalone CLI tool, not part of the main process.
- **Launch**: `npx tsx src/monitor.ts` → serves at `http://localhost:3002`
- **Architecture**: Proxies active job data from the existing dashboard (`localhost:3001/api/status`), reads SQLite directly for tasks, scans filesystem for interviews and context health. Tiered refresh rates (2s for jobs, 10s for tasks/IPC, 60s for interviews/health).
- **Five panels**:
  1. **Active Jobs** — concurrency gauge, duration with color escalation, container status
  2. **Planned Tasks** — upcoming scheduled tasks with countdown, recent run pass/fail dots
  3. **Subroutines** — pending IPC messages across groups, idle-waiting containers
  4. **Managed Interviews** — progress bars from elicitation_checklist.json, conversation state, CRM stage
  5. **Context Health** — cache hit rate from usage-report.jsonl, context size per group (CLAUDE.md + memory files)

### Managed Conversation Routing
- **Problem**: All emails to thomas@commitimpact.com landed in the `thomas-email` group regardless of sender. Managed interviews (Jeremy/Retrofit, show-and-tell contacts, etc.) had dedicated group directories with CLAUDE.md and elicitation checklists, but emails never routed there. Joel had to manually tell Thomas in main to handle them, polluting main's context.
- **Solution**: Email channel now checks `groups/*/managed_state_index.json` to build a sender-to-group routing table. Emails from managed senders route directly to their group's container.
- **Scope**: Only enabled for thomas@commitimpact.com (`enableManagedRouting: true` in email-accounts.json). Joel's inbox is untouched.
- **Auto-registration**: `index.ts` scans for groups with `managed_state_index.json` at startup and registers them as `managed:{folder}` with `requiresTrigger: false` — no @Thomas needed, fully autonomous.
- **Reply path**: Reply context stored under both the account JID and managed JID. `sendMessage` resolves managed JIDs back to the parent account for credentials.
- **7 routes discovered**: jeremy@retrofit.design, stephen.fengzh@gmail.com, benjamin@paperspaceship.audio, craig@launchpress.com, kevin@codefiworks.com, zsmulder@gmail.com, cf@the-web-guys.com
- **Verified working**: Jeremy emailed Thomas → routed to `managed:retrofit-design` → container processed with elicitation checklist → sent Round 1 questions → updated checklist to `round_1_sent` → sent summary to main via IPC. Main context never touched.

### Files Changed
- `src/channels/email.ts` — backoff logic, managed routing, `enableManagedRouting` config
- `src/index.ts` — `registerManagedGroups()` auto-registration at startup
- `src/monitor.ts` — new standalone dashboard
- `src/dashboard.ts` — unchanged (monitor is separate)
- `data/email-accounts.json` — added `enableManagedRouting: true` to Thomas
- `data/email-credentials/*/credentials.json` — refreshed tokens with full scopes
