# Plan: NanoClaw Git Strategy

## Context
NanoClaw is WAY ahead of GitHub main. No commits since forking. Two categories of content mixed together in the working tree. Need to separate and commit.

## Two Categories

### Category 1: Platform Code (goes in git)
Joel's fork of NanoClaw — the infrastructure, Thomas's personality, skills, container changes.

**Modified files** (already tracked upstream, need committing):
- `src/channels/whatsapp.ts`, `src/config.ts`, `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/mount-security.ts`, `src/task-scheduler.ts`, `src/whatsapp-auth.ts`
- `src/container-runner.test.ts`, `src/routing.test.ts`, `src/ipc-auth.test.ts`
- `container/Dockerfile`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`
- `container/skills/agent-browser/SKILL.md`
- `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`
- `package.json`, `package-lock.json`, `.env.example`
- `.claude/skills/setup/scripts/04-auth-whatsapp.sh`, `.claude/skills/setup/scripts/09-verify.sh`

**New files** (untracked, need adding):
- `src/channels/email.ts`, `src/channels/telegram.ts`, `src/channels/telegram.test.ts`
- `src/cli.ts`, `src/dashboard.ts`, `src/monitor.ts`, `src/usage-tracker.ts`
- `src/index.ts` (deleted + re-created — shows as D + ??)
- `container/skills/ceb/`, `container/skills/client-onboarding/`, `container/skills/email-contact-harvest/`, `container/skills/meeting-prep/`, `container/skills/morning-briefing/`, `container/skills/tool-finder/`, `container/skills/web-decoder/`
- `.claude/skills/provision-mcp/`, `.claude/skills/randd/`
- `PROGRESS.md`, `issues/`

**NOT platform** (exclude from git):
- `joel2.png`, `thomas_avatar.png`, `nanoclaw-diagram.html` — one-off assets
- `usage-report.jsonl` — runtime data
- `claude-talk-to-figma-mcp/` — external MCP clone, not part of nanoclaw

### Category 2: Runtime State (separate backup, gitignored)
Thomas's work product — client data, CRM state, group memory.

- `groups/*/` (except main/CLAUDE.md and global/CLAUDE.md which are already tracked)
- `contacts/`, `accounts/`, `opportunities/`
- `context-dump/`, `LBP/`, `randd/`
- `data/` (already gitignored — DB, sessions, credentials)
- `logs/` (already gitignored)

## Steps

### Step 1: Update .gitignore
Add explicit ignores for Category 2 and one-off files:
```
# Runtime state (Thomas's work product — backed up separately)
contacts/
accounts/
opportunities/
context-dump/
LBP/
randd/
usage-report.jsonl

# One-off assets
*.png
nanoclaw-diagram.html

# External repos
claude-talk-to-figma-mcp/

# Local env
.local/
```

### Step 2: Create branch `joel/thomas`
```bash
git checkout -b joel/thomas
```
This branch tracks Joel's fork. Main stays aligned with upstream for rebasing.

### Step 3: Commit platform changes
Stage all Category 1 files (modified + new). Do NOT use `git add -A`. Add files explicitly.

Split into logical commits if sensible, or one big initial commit is fine given the scope.

Suggested single commit message:
```
feat: add email/telegram channels, managed conversations, dashboard, CLI

Major additions to NanoClaw for Joel's Thomas agent:
- Email channel with Gmail OAuth, managed conversation routing
- Telegram channel (replaced WhatsApp as primary)
- Managed conversation containers with upstream reporting
- inject_context feedback loop from main to managed containers
- Standalone monitor dashboard
- CLI mode for local testing
- Container skills: CEB, client-onboarding, web-decoder, etc.
- Usage tracking
```

### Step 4: Push branch
```bash
git push -u origin joel/thomas
```

### Step 5: Backup script for runtime state
Create `scripts/backup-state.sh` that tars up Category 2 dirs. Add to gitignore the backup output. Can be run manually or via cron.

Target: `~/.nanoclaw-backups/state-{date}.tar.gz` containing:
- `groups/` (full — all group memory, logs, state files)
- `contacts/`, `accounts/`, `opportunities/`
- `data/nanoclaw.db` (the SQLite DB)
- `data/email-accounts.json`, `data/email-channel-state.json`

NOT backed up (recreatable): `data/sessions/`, `data/ipc/`, `node_modules/`, `dist/`

### Step 6: Verify
- `git status` shows clean working tree (all platform files committed, all runtime files gitignored)
- `joel/thomas` branch pushed to origin
- Backup script works and produces a valid tarball
