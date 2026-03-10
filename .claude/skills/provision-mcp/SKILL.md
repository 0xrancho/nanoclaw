---
name: provision-mcp
description: Automatically discover, validate, and install MCP servers when current tools are insufficient. In headless/auto mode, provisions transparently and respawns sub-agent with updated config. In supervised mode, requests user approval first. Container isolation makes global vs local installs equivalent.
---

# MCP Server Provisioning

Autonomously provision new MCP servers when tasks require capabilities not available in the current toolkit. This skill should be invoked **proactively** when the agent identifies a capability gap.

## Architecture Principles

**Container Isolation**
- npm global installs inside containers are already isolated
- Use whatever installation method the MCP server recommends (npx, global, or local)
- Container boundary provides scope - no additional restrictions needed

**Headless Operation**
- Install MCP → Spawn sub-agent with updated config → Continue task
- Fully transparent to user (no interruption)
- Only applicable in interactive Claude Code sessions does user see restart prompts

**Project Governance**
- **Auto mode**: Provision automatically, respawn subprocess, continue (transparent)
- **Supervised mode**: Surface provisioning need, wait for user approval, then proceed
- Trust levels (high/medium/low) inform security review, NOT user prompting

**Audit Trail**
- Every installation logged to `/workspace/project/data/mcp-audit.jsonl`
- Includes: timestamp, server, registry, task context, security result
- Failed installations also logged

## Core Principle

**When you can't do something → find, validate, install the tool, respawn with new config, and complete the task.**

In auto mode: fully transparent.
In supervised mode: get approval first, then proceed transparently.

## When to Use This Skill

### Proactive Triggers (Auto-invoke)
- User asks to interact with a service you can't access (Linear, Notion, Calendar, Slack, etc.)
- Task requires file operations beyond basic read/write (image processing, PDF manipulation, etc.)
- Need specialized search capabilities (vector search, semantic search)
- Require data transformation tools (JSON processing, CSV operations)
- Need authentication flows you can't handle

### Explicit Triggers
- User says "install an MCP server for X"
- User asks "can you add support for Y?"
- Following up on previous capability gaps

### Do NOT Use When
- Existing tools can accomplish the task (check first!)
- User explicitly forbids new installations
- Task is conversational/informational only

## Workflow

### Phase 0: Check Project Profile (FIRST)

**CRITICAL: This is the primary decision gate.**

**0.1 Read Project Profile**

```bash
# Check for project governance config
cat /workspace/project/.nanoclaw/profile.json 2>/dev/null || echo '{"mode":"supervised"}'
```

**Profile structure:**
```json
{
  "mode": "auto" | "supervised",
  "mcp_provisioning": {
    "enabled": true,
    "auto_install": true | false,
    "allowed_registries": ["smithery", "lobehub", "npm"],
    "require_approval_for": ["community", "write_access"]
  }
}
```

**0.2 Determine Mode**

**Auto Mode:**
- `mode: "auto"` OR `mcp_provisioning.auto_install: true`
- Provision automatically without user prompts
- Spawn sub-agent with updated config
- Complete task transparently

**Supervised Mode (DEFAULT):**
- `mode: "supervised"` OR profile doesn't exist
- Surface provisioning need to user
- Wait for explicit approval
- Then proceed with installation and sub-agent spawn

**0.3 Decision Point**

```
If auto mode:
  → Proceed to Phase 1 (no user interaction)
  → After install: spawn sub-agent, continue task

If supervised mode:
  → Proceed to Phase 1 for discovery
  → Before install: get user approval
  → After approval: install, spawn sub-agent, continue task
```

**Note:** Until project profiles are implemented, **treat all projects as supervised mode by default**.

### Phase 1: Capability Gap Analysis

**1.1 Identify the Need**
- What capability is missing?
- What specific operations are needed? (read-only, write, both)
- Any constraints? (group permissions, security requirements)

**Example:**
```
User: "Create a Linear ticket for this bug"
Gap: No Linear API access
Operations: Write (create issue), potentially read (search projects)
```

**1.2 Check Existing Tools First**
Before provisioning, verify the capability truly doesn't exist:
- Review available MCP servers: `claude mcp list`
- Check if a similar tool can accomplish the task
- Consider if bash/web tools can substitute

**Only proceed if the gap is real.**

### Phase 2: Discovery

**2.1 Search MCP Registries**

Query multiple registries in parallel for relevant servers:

**Primary Registries (2026):**
- **Smithery.ai** - Main registry, hosted and local servers
- **LobeHub MCP Directory** - Community-curated collection
- **MCP.so** - Search-focused directory
- **GitHub smithery-ai/reference-servers** - Official examples
- **npm** - npm packages with MCP server support

**Search Strategy:**
1. Use specific service names ("Linear MCP", "Google Calendar MCP")
2. Use capability keywords ("issue tracking MCP", "calendar integration MCP")
3. Check official sources (e.g., company-maintained servers)
4. Review MCP server's own installation documentation

**Search Commands:**
```bash
# Web search across registries
# Example: "Linear MCP server smithery lobehub 2026"

# npm search
npm search mcp linear

# GitHub search for official servers
# Example: search for "linear-mcp-server" org:company-name
```

**2.2 Candidate Evaluation**

For each candidate, gather:
- **Source**: GitHub repo URL, npm package name, or registry listing
- **Maintainer**: Official (company-maintained) vs community
- **Popularity**: Stars, downloads, recent activity
- **Documentation**: Quality of setup instructions
- **License**: Must be permissive (MIT, Apache, BSD)
- **Recommended install method**: npx, global npm, local install, hosted

Create a shortlist of 1-3 candidates, prioritizing:
1. Official servers from the service provider
2. High-quality community servers (>500 stars, recent commits)
3. Servers listed in Smithery with "reviewed" status

### Phase 3: Security Validation

**CRITICAL: Never install unvalidated MCP servers.**

For each candidate, perform security checks following [OWASP MCP Security Guidelines (2026)](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/):

**3.1 Source Code Review**

```bash
# Clone the repository
git clone <repo-url> /tmp/mcp-review-$(date +%s)
cd /tmp/mcp-review-*

# Check for red flags
grep -r "eval(" . --include="*.js" --include="*.ts"
grep -r "exec(" . --include="*.js" --include="*.ts"
grep -r "child_process" . --include="*.js" --include="*.ts"
grep -r "fs.writeFile" . --include="*.js" --include="*.ts"
grep -r "process.env" . --include="*.js" --include="*.ts"

# Review package.json dependencies
cat package.json | jq '.dependencies, .devDependencies'
```

**Red Flags (REJECT immediately):**
- Eval of user input
- Arbitrary command execution without sandboxing
- Writes to system directories outside workspace
- Requests excessive environment variables
- Obfuscated code
- No source repository (binary-only)
- Unsigned packages from unknown authors

**Green Flags (SAFE to proceed):**
- Official repository (e.g., github.com/linear/mcp-server)
- Clean dependency tree (no suspicious packages)
- Clear security.md or security policy
- Recent commits, active maintenance
- OAuth 2.1 for authentication (2026 standard)
- Input validation and sanitization
- Published by Anthropic, major tech companies, or verified authors

**3.2 Permission Analysis**

Check what the server requests access to:
```bash
# Read MCP server configuration
cat mcp.json || cat server-config.json

# Look for requested capabilities
# - File system access paths
# - Environment variables
# - Network endpoints
# - OAuth scopes
```

**3.3 Trust Level Classification**

**HIGH TRUST:**
- Official server from trusted source (Anthropic, major company)
- Read-only operations
- Listed in Smithery with "Anthropic Reviewed" badge
- Matches all security best practices

**MEDIUM TRUST:**
- Community-maintained with >500 stars
- Active maintenance (<3 months since last commit)
- Clean code review but not official
- Write permissions limited to workspace

**LOW TRUST (REJECT):**
- Red flags detected
- No source code available
- Unmaintained (>6 months no commits)
- Excessive permissions

**3.4 Validation Decision**

**In AUTO mode:**
- HIGH TRUST → Auto-install
- MEDIUM TRUST → Check profile for `require_approval_for: ["community"]`
  - If approval required: fall back to supervised behavior
  - If not required: auto-install
- LOW TRUST → Reject, log failure

**In SUPERVISED mode:**
- HIGH TRUST → Present to user with "recommended" label
- MEDIUM TRUST → Present to user with details
- LOW TRUST → Reject, inform user why

### Phase 4: Pre-Installation Audit

**BEFORE installing anything, write a structured audit log.**

**4.1 Create Audit Entry**

Append to `/workspace/project/data/mcp-audit.jsonl`:

```bash
# Ensure audit directory exists
mkdir -p /workspace/project/data

# Create structured log entry
cat >> /workspace/project/data/mcp-audit.jsonl <<EOF
{"timestamp":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","action":"install_initiated","server":"<package-name>","registry":"<source>","triggered_by":"<task-description>","security_check":"<high|medium|low>","trust_level":"<high|medium|rejected>","source_url":"<repo-url>","maintainer":"<official|community>","mode":"<auto|supervised>","user_approved":<true|false|null>}
EOF
```

**Required fields:**
- `timestamp`: ISO 8601 UTC
- `action`: "install_initiated"
- `server`: Package/server name
- `registry`: Which registry it came from (smithery/lobehub/github/npm)
- `triggered_by`: Brief task description (e.g., "Create Linear ticket")
- `security_check`: Security review result
- `trust_level`: "high", "medium", or "rejected"
- `source_url`: GitHub or registry URL
- `maintainer`: "official" or "community"
- `mode`: "auto" or "supervised"
- `user_approved`: true (if supervised and approved), false (if rejected), null (if auto)

### Phase 5: User Approval (SUPERVISED MODE ONLY)

**Skip this phase entirely in AUTO mode.**

**5.1 Present Provisioning Need**

Use `AskUserQuestion` to get approval:

**For HIGH TRUST servers:**
```
Question: "Install <Service> MCP server to complete this task?"
Header: "Tool Install"
Options:
  - label: "Install (Recommended)"
    description: "Official <Service> MCP server, security review passed"
  - label: "Skip"
    description: "Don't install, I'll provide an alternative approach"
```

**For MEDIUM TRUST servers:**
```
Question: "Install <Package> MCP server (community-maintained)?"
Header: "Tool Install"
Options:
  - label: "Install"
    description: "<Stars> GitHub stars, last commit <date>, clean security review"
  - label: "Skip"
    description: "Find a different solution"
  - label: "More details"
    description: "Show full security review and source code"
```

**5.2 Handle Response**

If approved:
- Update audit log: `user_approved: true`
- Proceed to Phase 6

If rejected:
- Update audit log: `{"action":"install_failed","reason":"user_rejected",...}`
- Inform user: "Understood. What would you like to do instead?"
- Stop workflow

If "more details":
- Show security review summary
- Link to source repository
- Re-ask with same options

### Phase 6: Installation

**6.1 Prepare Environment**

Check if add-mcp CLI is available:
```bash
which add-mcp || npm list -g add-mcp
```

If not installed:
```bash
npm install -g add-mcp
```

**6.2 Installation Method**

**Follow the MCP server's recommended installation method from its documentation.**

**Common patterns:**

**Remote/Hosted MCP (Preferred):**
```bash
npx add-mcp <server-url>
```
- Server runs on external infrastructure (Smithery, vendor-hosted)
- Container accesses via network
- No local execution needed

**npm Global Install:**
```bash
npm install -g <package-name>
npx add-mcp npm:<package-name>
```
- Installs package globally in container
- Container isolation provides scope
- Equivalent to local install within container boundary

**npm Local Install:**
```bash
npm install <package-name> --save
npx add-mcp local:node_modules/<package-name>
```
- Installs to project node_modules
- Useful for version pinning

**npx (No Install):**
```bash
npx add-mcp npx:<package-name>
```
- Runs on-demand without persistent install
- Good for testing

**Choose the method recommended in the MCP server's README/docs.**

**6.3 Configure for NanoClaw Container**

NanoClaw runs agents in containers. Configuration depends on install method:

**Remote/Hosted MCP:**
- No additional config needed
- add-mcp writes config automatically

**Local MCP (npm global or local):**

Option A: Let add-mcp handle it (automatic)
- Just run add-mcp command
- Tool auto-configures

Option B: Manual container config (if needed)
1. Add to container MCP config in `src/container-runner.ts`:
```typescript
// Add to mcpServers object
"service-name": {
  command: "node",
  args: ["/path/to/mcp-server/dist/index.js"],
  env: {
    SERVICE_API_KEY: process.env.SERVICE_API_KEY || ""
  }
}
```

2. Document required env vars in `.env.example`:
```bash
echo "SERVICE_API_KEY=# API key for Service MCP server" >> .env.example
```

**6.4 Add Environment Variables**

If the MCP server requires API keys or config:

```bash
# Add placeholder to .env
echo "SERVICE_API_KEY=<placeholder>" >> .env

# Add to .env.example for documentation
echo "SERVICE_API_KEY=# Get from https://service.com/settings/api" >> .env.example
```

**Tell user (supervised mode only):**
```
To complete setup, add your API key to .env:
SERVICE_API_KEY=<your-key-here>

Then sync to container:
mkdir -p data/env && cp .env data/env/env
```

**In auto mode:**
- Document in mcp-servers.md
- Note in audit log that API key needed
- Sub-agent will prompt for key if tool fails due to missing auth

**6.5 Rebuild for Container Config Changes**

If you modified `src/container-runner.ts`:
```bash
npm run build
```

**6.6 Update Audit Log - Installation Complete**

```bash
cat >> /workspace/project/data/mcp-audit.jsonl <<EOF
{"timestamp":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","action":"install_completed","server":"<package-name>","status":"success","install_method":"<global|local|remote|npx>"}
EOF
```

### Phase 7: Sub-Agent Spawn & Task Continuation

**This is where the workflow differs from traditional "restart required" approaches.**

**7.1 Document Installation**

Create or append to `/workspace/group/mcp-servers.md`:
```markdown
## <Service Name>

**Installed:** <ISO-date>
**Package:** `<package-name>`
**Registry:** <smithery/lobehub/github/npm>
**Source:** <repo-url>
**Maintainer:** <official/community>
**Trust Level:** <high|medium>
**Install Method:** <global|local|remote|npx>
**Purpose:** <what it does>

**Environment Variables Required:**
- `SERVICE_API_KEY`: <where to get it>

**Tools Available:**
- `tool-name-1`: Description
- `tool-name-2`: Description

**Installed for task:** <brief task description>

---
```

**7.2 Spawn Sub-Agent with Updated Config**

**In headless/automated operation (NanoClaw background service):**

```typescript
// Pseudo-code for sub-agent spawn pattern
const subAgent = spawnAgent({
  task: originalTaskDescription,
  context: {
    newMCP: installedServerName,
    originalRequest: userRequest
  },
  reloadMCPConfig: true  // Force config reload
});

await subAgent.execute();
// Sub-agent now has the new MCP server available
// It completes the original task
```

**In interactive Claude Code sessions:**

The principle agent (this session) cannot reload MCP config. Instead:
- Document installation in mcp-servers.md
- Create restart notice for user
- User must start new session manually

**7.3 Verify Sub-Agent Has Tool**

```bash
# Sub-agent checks MCP is available
claude mcp list | grep -i <service-name>
```

If not found:
- Check config location: `cat /workspace/project/.claude/settings.json`
- Verify installation: Check audit log
- May need manual config update

**7.4 Complete Original Task**

Sub-agent (or new session) completes the user's original request:

```
User: "Create a Linear ticket for this bug"
→ Sub-agent uses Linear MCP to create the ticket
→ Reports ticket URL and details to user
→ Updates audit log with task completion
```

**7.5 Update Audit Log - Task Completion**

```bash
cat >> /workspace/project/data/mcp-audit.jsonl <<EOF
{"timestamp":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","action":"task_completed","server":"<package-name>","original_task":"<task>","outcome":"<success|partial|failed>","completed_by":"<sub-agent-id|new-session>"}
EOF
```

**7.6 Return Result to User**

**In AUTO mode:**
```
✅ Task completed using newly provisioned <Service> MCP server.

<task result details>

(MCP server installation was automatic and transparent)
```

**In SUPERVISED mode:**
```
✅ Installed <Service> MCP server and completed your task.

<task result details>

Details logged in mcp-servers.md
```

## Security Checklist

Before installing ANY MCP server, verify:

- [ ] Source code is publicly available and reviewable
- [ ] No arbitrary code execution (eval, child_process without validation)
- [ ] No writes outside workspace without explicit user permission
- [ ] Dependencies are clean (no malicious packages)
- [ ] Authentication uses OAuth 2.1 or API keys (not credentials in code)
- [ ] Input validation and sanitization present
- [ ] Maintained within last 3 months OR official/stable release
- [ ] Permissions match stated purpose (no scope creep)
- [ ] License is permissive (MIT, Apache, BSD)
- [ ] Either official source OR high community trust (>500 stars, active)
- [ ] **Audit log written BEFORE installation**
- [ ] **Project profile checked for governance mode**
- [ ] **MCP server's recommended install method used**

**If ANY check fails → Reject in auto mode, inform user in supervised mode.**

## Audit Log Format

**Location:** `/workspace/project/data/mcp-audit.jsonl`
**Format:** JSON Lines (one JSON object per line, append-only)

**Event Types:**

**install_initiated:**
```json
{
  "timestamp": "2026-02-23T00:45:00Z",
  "action": "install_initiated",
  "server": "@linear/mcp-server",
  "registry": "npm",
  "triggered_by": "Create Linear ticket for bug report",
  "security_check": "passed",
  "trust_level": "high",
  "source_url": "https://github.com/linear/mcp-server",
  "maintainer": "official",
  "mode": "auto",
  "user_approved": null
}
```

**install_completed:**
```json
{
  "timestamp": "2026-02-23T00:45:15Z",
  "action": "install_completed",
  "server": "@linear/mcp-server",
  "status": "success",
  "install_method": "npm-global"
}
```

**task_completed:**
```json
{
  "timestamp": "2026-02-23T00:46:00Z",
  "action": "task_completed",
  "server": "@linear/mcp-server",
  "original_task": "Create Linear ticket for bug report",
  "outcome": "success",
  "details": "Created issue LIN-123",
  "completed_by": "sub-agent-abc123"
}
```

**install_failed:**
```json
{
  "timestamp": "2026-02-23T00:45:10Z",
  "action": "install_failed",
  "server": "sketchy-tool",
  "reason": "Security check failed: arbitrary code execution detected",
  "trust_level": "rejected"
}
```

## Project Profile Reference

**Location:** `/workspace/project/.nanoclaw/profile.json`

**Example:**
```json
{
  "mode": "auto",
  "mcp_provisioning": {
    "enabled": true,
    "auto_install": true,
    "allowed_registries": ["smithery", "lobehub", "npm"],
    "require_approval_for": ["community", "write_access"],
    "max_trust_level": "medium"
  }
}
```

**Fields:**
- `mode`: "auto" or "supervised" (global governance)
- `mcp_provisioning.enabled`: Allow MCP provisioning at all
- `mcp_provisioning.auto_install`: Install without user prompts (auto mode)
- `mcp_provisioning.allowed_registries`: Which registries to search
- `mcp_provisioning.require_approval_for`: Override auto for specific conditions
- `mcp_provisioning.max_trust_level`: Don't auto-install below this trust level

**Default (if profile.json doesn't exist):**
```json
{
  "mode": "supervised"
}
```

## Registry Reference (2026)

### Primary Registries

**Smithery.ai**
- URL: https://smithery.ai
- Features: Hosted + local servers, security reviews
- Trust level: High (Anthropic partnership)

**LobeHub MCP Directory**
- URL: https://lobehub.com/mcp
- Features: Community-curated, detailed docs
- Trust level: Medium (community-driven)

**MCP.so**
- URL: https://mcp.so
- Features: Search-focused directory
- Trust level: Medium

**npm**
- URL: https://www.npmjs.com
- Search: `npm search mcp <service>`
- Trust level: Varies (check maintainer)

**GitHub**
- URL: https://github.com/smithery-ai/reference-servers
- Features: Official example implementations
- Trust level: High (official)

### Installation Tools

**add-mcp CLI**
- Install: `npm install -g add-mcp`
- Usage: `npx add-mcp <server-url|npm:package|local:path|npx:package>`
- Auto-detects: Claude Code, Cursor, VS Code, Codex, etc.

## Common MCP Servers (Pre-validated)

These are known-safe servers with HIGH TRUST level:

### Official Anthropic Servers
- **Filesystem**: `@anthropic/filesystem-mcp` - Local file operations
- **GitHub**: `@anthropic/github-mcp` - GitHub API access
- **Google Drive**: `@anthropic/google-drive-mcp` - Drive integration

### Verified Servers (Official from providers)
- **Linear**: `@linear/mcp-server` (official, Linear team)
- **Notion**: `@notion/mcp-server` (official, Notion)
- **Slack**: `@slack/mcp-server` (official, Slack)

**For these servers:**
- Expedited security review (skip deep code review)
- AUTO mode: Install automatically
- SUPERVISED mode: Present with "recommended" label

## Troubleshooting

### Sub-Agent Doesn't See New MCP
- Check audit log: `cat /workspace/project/data/mcp-audit.jsonl | grep <server>`
- Verify config: `cat /workspace/project/.claude/settings.json`
- Check add-mcp succeeded: Look for errors in install output
- Manual config: Add to settings.json if auto-config failed

### Authentication Failures
- Verify API keys in `.env`
- Check sync to container: `cat data/env/env | grep SERVICE`
- Review OAuth flow in MCP server docs
- Check scopes match permissions

### Container Can't Reach Remote MCP
- Check network from container
- Verify firewall rules
- Test connectivity: `curl <mcp-server-url>`

### Auto Mode Not Working
- Verify profile exists: `cat /workspace/project/.nanoclaw/profile.json`
- Check `mode: "auto"` is set
- Verify trust level allows auto-install
- Check audit log for rejection reason

## Best Practices

1. **Check project profile first** - Determines auto vs supervised behavior
2. **Use recommended install method** - Follow MCP server's documentation
3. **Prefer official sources** - Company-maintained > community when available
4. **Always audit** - Write log BEFORE installing
5. **Spawn sub-agent** - Don't interrupt workflow (in headless operation)
6. **Document immediately** - Update mcp-servers.md during install
7. **Monitor audit log** - Watch for patterns and issues
8. **Remove unused servers** - Reduce attack surface

## Example Workflows

### Example 1: AUTO Mode - Transparent Provisioning

**Scenario:** Headless NanoClaw service, auto mode enabled

User: "Create a Linear ticket for this bug"

Agent (this session):
```
1. Gap analysis: Need Linear API access
2. Check profile: mode="auto", auto_install=true
3. Discovery: Found @linear/mcp-server (npm)
4. Security: ✅ Official, high trust
5. Audit: Log install_initiated (mode="auto", user_approved=null)
6. Install: npm install -g @linear/mcp-server && npx add-mcp npm:@linear/mcp-server
7. Audit: Log install_completed
8. Spawn sub-agent with reloadMCPConfig=true
```

Sub-agent (new process):
```
1. Verify Linear MCP loaded ✅
2. Create Linear issue LIN-123
3. Audit: Log task_completed (completed_by="sub-agent-abc123")
4. Return result to user
```

User sees:
```
✅ Created Linear issue LIN-123: [Bug] Memory leak in auth service
→ https://linear.app/team/issue/LIN-123
```

(Installation was completely transparent)

### Example 2: SUPERVISED Mode - User Approval

**Scenario:** Interactive Claude Code session, supervised mode

User: "Resize this image to 800x600"

Agent:
```
1. Gap analysis: Need image processing
2. Check profile: mode="supervised" (default)
3. Discovery: Found sharp-mcp-server (npm, community)
4. Security: MEDIUM TRUST (300 stars, clean code, community-maintained)
5. Audit: Log install_initiated (mode="supervised")
6. AskUserQuestion:
   "Install sharp-mcp-server for image processing?
   (Community-maintained, 300 stars, clean security review)"
```

User approves:
```
7. Audit: Update user_approved=true
8. Install: npm install -g sharp-mcp-server && npx add-mcp npm:sharp-mcp-server
9. Audit: Log install_completed
10. Inform user: "Installed sharp-mcp-server. Starting new session to load the tool..."
11. User manually restarts session (interactive context)
```

New session:
```
12. User retries: "Resize this image to 800x600"
13. Agent verifies sharp MCP loaded ✅
14. Resizes image → result.jpg
15. Audit: Log task_completed
```

### Example 3: Rejected - Security Failure

User: "Install sketchy-automation-tool"

Agent:
```
1. Discovery: Found github.com/unknown/sketchy-tool
2. Security review:
   - Found: eval() with user input
   - Found: child_process.exec() without validation
   - No commits in 8 months
   - Only 12 stars
3. Trust level: REJECTED
4. Audit: Log install_failed (trust_level="rejected", reason="Security check failed")
5. Response to user:
   "❌ Cannot install sketchy-automation-tool

   Security issues detected:
   - Arbitrary code execution without sandboxing
   - Unmaintained (8+ months)

   What are you trying to accomplish? I can suggest safer alternatives."
```

## References

**Security Guidelines:**
- [OWASP MCP Security Guide (2026)](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [WorkOS MCP Security Guide](https://workos.com/blog/mcp-security-risks-best-practices)

**Installation Tools:**
- [add-mcp CLI](https://neon.com/blog/add-mcp)
- [Anthropic Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions)

**Registries:**
- [Smithery.ai](https://smithery.ai)
- [LobeHub MCP Directory](https://lobehub.com/mcp)
- [MCP.so](https://mcp.so)
