# Issue: Managed Conversations Have No Internal Upstream Channel

## Problem

Managed conversation containers (e.g. `managed:retrofit-design`) have no way to send internal reports to Joel/main. Everything the agent outputs — streaming text AND IPC `send_message` — routes back to the external contact via email.

Thomas correctly identified this as a routing problem and stopped processing emails rather than leak internal content to Jeremy.

## Architecture Context

**Normal subgroups** (e.g. `internal:research`):
- Dispatched BY main via `dispatch_task`
- Output routes back to main's Telegram chat
- Never needed cross-group IPC because output already goes to main

**Managed conversations** (e.g. `managed:retrofit-design`):
- Triggered by INBOUND email from external contact
- Streaming output → email reply to external contact (correct)
- `send_message` IPC → targets own chatJid (`managed:X`) → loops back as email to external contact (wrong for internal)
- No path to reach main/Joel

## What Was Built (Partially Working)

1. `report_to_main` MCP tool in `ipc-mcp-stdio.ts` — only registered for managed containers
2. `NANOCLAW_MAIN_CHAT_JID` env var passed from host → container → MCP server
3. IPC auth rule in `ipc.ts` allowing `report_to_main` type from managed groups to main
4. `send_message` hidden from managed containers (to prevent confusion)
5. Session resume disabled for managed groups (each email = fresh turn)

## What's Still Broken

Thomas has Gmail MCP mounted and uses it directly to compose/send emails. When told to "reply to the email AND report internally", Thomas:
1. Reads the email via Gmail MCP
2. Sends reply via Gmail MCP (`mcp__gmail__send_email`)
3. Sends internal report via Gmail MCP (another email — LEAK)
4. Streaming output ALSO triggers an email reply (duplicate)

**Root cause:** Thomas has full Gmail access (correctly — he needs it for other groups). In managed containers, he uses Gmail to send emails directly instead of letting the streaming output handle the reply. The `report_to_main` tool exists but Thomas defaults to Gmail for everything.

## Constraints

- Thomas MUST keep full Gmail/Calendar/Drive MCP access — these are core tools, not just for managed conversations
- Managed containers share the same container image as all other groups
- The email reply pipeline (streaming output → email channel → reply) must remain the primary outbound path for managed conversations
- `report_to_main` must be the ONLY internal channel — no leaking via Gmail sends

## What Needs to Happen

The solution must ensure that in managed containers:
1. Streaming output goes to the external contact (email reply) — already works
2. `report_to_main` goes to main/Telegram — tool exists and IPC auth works
3. Thomas cannot accidentally send internal content to the external contact via Gmail MCP
4. Thomas retains full read access to Gmail (he needs to read the email thread)

### Possible Approaches

**A. Gmail send hook/filter in managed containers:**
Pre-tool-use hook in agent-runner that blocks `mcp__gmail__send_email` / `mcp__gmail__send_draft` calls in managed containers. Thomas can read but not send via Gmail. All outbound goes through streaming output (client-facing) or `report_to_main` (internal).

**B. CLAUDE.md behavioral guardrails (proven insufficient alone):**
Already tried. Thomas still uses Gmail directly. Prompting alone doesn't solve this.

**C. Separate MCP server configs per container type:**
Too much complexity. Violates the single-image principle.

**D. Hybrid: Hook + CLAUDE.md:**
Block Gmail sends in managed containers via hook. Add clear CLAUDE.md instructions about the two output channels. The hook is the enforcement, CLAUDE.md is the guidance.

## Recommendation

**Approach D (Hybrid).** The agent-runner already has a `preToolUse` hook system. Add a check: if `isManaged` and the tool is `mcp__gmail__send_email` or `mcp__gmail__send_draft`, block it with a clear error message telling Thomas to use streaming output for client replies and `report_to_main` for internal reports.

## Files to Change

- `container/agent-runner/src/index.ts` — Add pre-tool-use hook for managed containers blocking Gmail sends
- `groups/*/CLAUDE.md` (managed groups) — Document the two output channels
- Verify `report_to_main` IPC flow end-to-end

## Test Plan

1. Send email from joelaustin.co@gmail.com to thomas@commitimpact.com
2. Verify: email reply arrives (via streaming output, not Gmail MCP)
3. Verify: Telegram message arrives in main (via `report_to_main`)
4. Verify: no Gmail send calls succeed (hook blocks them)
5. Verify: Thomas can still READ emails via Gmail MCP
6. Clean up test-report group

## Current State of Code

All changes from this session are uncommitted. The `report_to_main` tool, IPC auth, session handling, and `send_message` gating are in place. The missing piece is the Gmail send block for managed containers.

### Key files already modified:
- `src/ipc.ts` — `report_to_main` auth rule (lines 97-109)
- `src/index.ts` — `mainChatJid` resolution, session skip for managed groups
- `src/container-runner.ts` — `mainChatJid` in ContainerInput
- `src/task-scheduler.ts` — `mainChatJid` passthrough
- `container/agent-runner/src/index.ts` — env var passthrough, ContainerInput interface
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `report_to_main` tool, `send_message` gating
- `groups/retrofit-design/CLAUDE.md` — output channel documentation
- `groups/test-report/` — test managed group (delete after fix)
