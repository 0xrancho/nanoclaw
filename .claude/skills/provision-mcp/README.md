# Provision MCP Skill

**Status:** ✅ Design Complete
**Version:** 1.0.0
**Created:** 2026-02-22

## Overview

The `provision-mcp` skill enables autonomous discovery, validation, and installation of MCP servers when the agent encounters capability gaps. Instead of telling users "I can't do that," the agent proactively finds and installs the appropriate tool, validates it's safe, and completes the task.

## Key Features

### 🔍 Autonomous Discovery
- Searches multiple MCP registries (Smithery.ai, LobeHub, MCP.so)
- Prioritizes official servers from service providers
- Evaluates candidates by popularity, maintenance, and documentation

### 🔒 Security-First Validation
- Implements OWASP MCP Security Guidelines (2026)
- Reviews source code for red flags (eval, arbitrary execution, etc.)
- Checks dependency trees for malicious packages
- Validates OAuth 2.1 compliance and permission scopes
- Auto-rejects unsafe servers, asks user for medium-risk ones

### ⚡ Automated Installation
- Uses `add-mcp` CLI for cross-platform installation
- Handles project-level and global scopes
- Configures container environments for NanoClaw
- Syncs environment variables automatically

### ✅ Testing & Validation
- Verifies installation success
- Runs integration tests with new tools
- Documents installations in `mcp-servers.md`
- Provides rollback on failure

### 🎯 Task Completion
- Completes the original task that triggered the need
- Updates group memory with new capabilities
- Provides usage guidance

## Architecture

```
User Request
    ↓
┌─────────────────────┐
│ Gap Analysis        │ ← Check if existing tools can do it
└─────────────────────┘
    ↓ (gap confirmed)
┌─────────────────────┐
│ Discovery           │ ← Search registries in parallel
│ - Smithery.ai       │
│ - LobeHub           │
│ - MCP.so            │
│ - GitHub            │
└─────────────────────┘
    ↓
┌─────────────────────┐
│ Security Validation │ ← CRITICAL: Never skip this
│ - Source review     │
│ - Dependency check  │
│ - Permission audit  │
│ - Red flag detection│
└─────────────────────┘
    ↓
┌─────────────────────┐
│ Installation        │ ← Use add-mcp CLI
│ - Install via CLI   │
│ - Configure env     │
│ - Setup container   │
└─────────────────────┘
    ↓
┌─────────────────────┐
│ Testing             │ ← Verify it works
│ - Integration test  │
│ - Simple operation  │
└─────────────────────┘
    ↓
┌─────────────────────┐
│ Task Completion     │ ← Complete original request
│ - Use new tool      │
│ - Update docs       │
│ - Report to user    │
└─────────────────────┘
```

## Security Model

### Trust Levels

**HIGH TRUST (Auto-install):**
- Official Anthropic MCP servers
- Official servers from major companies (Linear, Notion, Slack)
- Servers with "Anthropic Reviewed" badge on Smithery
- Read-only servers from established sources

**MEDIUM TRUST (Ask user):**
- Community servers with >500 stars
- Active maintenance (commits within 3 months)
- Clean code review but not official source
- Write permissions to workspace only

**LOW TRUST (Reject):**
- Red flags in code review
- Unmaintained (>6 months no activity)
- Suspicious dependencies
- Excessive permissions
- No source code available

### Security Checklist

Every installation must pass:
- ✅ Source code publicly available
- ✅ No arbitrary code execution
- ✅ No system writes without permission
- ✅ Clean dependencies
- ✅ OAuth 2.1 or API key auth
- ✅ Input validation present
- ✅ Recently maintained
- ✅ Permissions match purpose
- ✅ Permissive license
- ✅ Official OR high community trust

## Usage Examples

### Example 1: Linear Integration
```
User: "Create a Linear issue for this bug"

Agent:
1. Identifies need for Linear API
2. Searches registries → finds @linear/mcp-server (official)
3. Security validation → SAFE (official, OAuth 2.1, clean code)
4. Installs: npx add-mcp npm:@linear/mcp-server
5. Configures LINEAR_API_KEY in .env
6. Tests by creating test issue
7. Creates actual bug issue → reports URL to user
```

### Example 2: Image Processing
```
User: "Resize this image to 800x600"

Agent:
1. Identifies need for image manipulation
2. Searches → finds sharp-mcp-server (community, 300 stars)
3. Security validation → MEDIUM RISK (community, but clean)
4. Asks user: "Install sharp-mcp-server? (community, 300 stars)"
5. User approves → installs
6. Resizes image → returns result
```

### Example 3: Rejecting Unsafe Server
```
User: "Use sketchy-automation-tool"

Agent:
1. Reviews source code
2. Finds: arbitrary exec(), eval(), no validation
3. REJECTS installation
4. Explains: "Security issues detected: arbitrary command execution"
5. Asks: "What are you trying to accomplish? I can suggest safer alternatives"
```

## Integration with NanoClaw

### Container Configuration

NanoClaw runs agents in containers. MCP servers must be configured accordingly:

**Remote/Hosted MCP (Preferred):**
- No additional config needed
- Server runs outside container, accessed via network

**Local MCP (Advanced):**
- Install as project dependency
- Add to `src/container-runner.ts` mcpServers config
- Document env vars in `.env.example`

### Group Permissions

MCP servers can be restricted per group:
- Main group: Full access to all provisioned tools
- Other groups: Configured via `containerConfig` in `registered_groups.json`
- Admin can control which groups can provision new tools

## Installation

The skill itself doesn't need installation - it's a behavior pattern. Simply add it to `.claude/skills/` and the agent will use it when capability gaps are detected.

**Prerequisites:**
- `add-mcp` CLI (installed automatically on first use)
- Network access to MCP registries
- Permissions to modify `~/.claude/settings.json`

## Files Created/Modified

**Created:**
- `.claude/skills/provision-mcp/SKILL.md` - Main skill documentation
- `.claude/skills/provision-mcp/manifest.yaml` - Skill metadata
- `workspace/group/mcp-servers.md` - Installation log (created on first provision)

**Modified:**
- `~/.claude/settings.json` - MCP server configurations
- `.env` - API keys and credentials for MCP servers
- `data/env/env` - Container environment sync
- `src/container-runner.ts` - Local MCP server configs (if needed)

## Monitoring & Maintenance

### Check Installed Servers
```bash
claude mcp list
```

### Review Installation Log
```bash
cat /workspace/group/mcp-servers.md
```

### Update Servers
```bash
# Check for updates
npm outdated <mcp-package-name>

# Update specific server
npm update <mcp-package-name>

# Rebuild and restart
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Remove Server
```bash
claude mcp remove <server-name>

# Or manually edit ~/.claude/settings.json
```

## Troubleshooting

### Server Not Appearing
- Verify: `claude mcp list`
- Rebuild: `npm run build`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Logs: `tail -f logs/nanoclaw.log`

### Authentication Failures
- Check `.env` has correct API keys
- Verify sync: `cat data/env/env`
- Review OAuth flow in server docs

### Unexpected Behavior
- Review source code
- Check logs for errors
- Disable server: `claude mcp remove <name>`
- Report if malicious

## References

**Documentation:**
- [SKILL.md](./SKILL.md) - Complete skill implementation guide
- [manifest.yaml](./manifest.yaml) - Skill metadata

**External Resources:**
- [OWASP MCP Security Guide](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/)
- [add-mcp CLI](https://neon.com/blog/add-mcp)
- [Smithery.ai Registry](https://smithery.ai)
- [LobeHub MCP Directory](https://lobehub.com/mcp)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)

## License

Part of the NanoClaw project.

## Changelog

**1.0.0 (2026-02-22)**
- Initial design and documentation
- Security validation framework
- Integration with add-mcp CLI
- Container configuration support
- Multi-registry discovery
