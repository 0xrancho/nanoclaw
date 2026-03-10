# Production-Ready MCP Provisioning Skill

**Version:** 2.0.0 (Production-Safe)
**Updated:** 2026-02-22T23:45:00Z
**Status:** ✅ Ready for Testing

## Critical Fixes Applied

All four production-safety gaps have been addressed:

### ✅ 1. Session Restart Requirement

**Problem:** Original design assumed "install → use immediately" but MCP servers don't hot-load.

**Solution:**
- Phase 6 now **explicitly stops** after installation
- Creates `session-restart-required.txt` with clear instructions
- Documents installation in `mcp-servers.md`
- User notification includes mandatory restart notice
- Phase 7 handles post-restart verification in NEW session
- Workflow enforces: Install → Document → Stop → User restarts → Verify → Use

**Key Changes:**
```markdown
### Phase 6: Document & Stop (CRITICAL)
⚠️ DO NOT ATTEMPT TO USE THE NEW TOOL

**Your response to user MUST include:**
- "⚠️ SESSION RESTART REQUIRED"
- "Start a new conversation"
- "Retry your request: '<original-request>'"

DO NOT:
- Attempt to use the new tool
- Continue with the task
- Say "let me test it"
```

### ✅ 2. Project-Scoped Only (No Global)

**Problem:** Global installations affect all containers and can't be properly audited.

**Solution:**
- **ENFORCED:** All installations are project-scoped
- `--global` flag is explicitly forbidden in docs
- Phase 5.2 titled "Installation Scope (ENFORCED)"
- Security checklist includes verification step
- Audit log records `"installation_scope": "project"` for every install

**Key Changes:**
```bash
# Correct (project-scoped)
npx add-mcp <server-url>

# FORBIDDEN (global)
# npx add-mcp --global <anything>  ← DO NOT USE
```

**Enforcement in Code:**
- All example commands use project scope
- Documentation explicitly forbids global
- "Why project-scoped" section explains rationale
- Audit log validates scope

### ✅ 3. Structured Audit Logging

**Problem:** No audit trail of system changes.

**Solution:**
- **NEW Phase 4:** Pre-Installation Audit (runs BEFORE install)
- Audit log location: `/workspace/project/data/mcp-audit.jsonl`
- Append-only JSON Lines format
- Required fields: timestamp, action, server, registry, triggered_by, security_check, source_url, maintainer, installation_scope
- Events logged: install_initiated, persistence_verified, install_completed, first_use, task_completed, install_failed

**Event Types:**
```json
// Before installation
{"action":"install_initiated", "timestamp":"...", "server":"@linear/mcp-server", "triggered_by":"Create Linear ticket", "security_check":"passed", "installation_scope":"project"}

// After installation
{"action":"install_completed", "server":"@linear/mcp-server", "status":"success", "requires_restart":true}

// On failure
{"action":"install_failed", "server":"sketchy-tool", "reason":"Security check failed", "security_check":"rejected"}

// First use (next session)
{"action":"first_use", "server":"@linear/mcp-server", "status":"success", "test":"Listed projects"}

// Task completion
{"action":"task_completed", "server":"@linear/mcp-server", "outcome":"success", "details":"Created LIN-123"}
```

**Audit Requirements:**
- Log written BEFORE any installation attempt
- Failed installations also logged
- Includes task context (what triggered the need)
- Security check result recorded
- Persistence verification logged separately

### ✅ 4. Persistence Verification

**Problem:** Unclear if MCP config survives container restarts.

**Solution:**
- **NEW Phase 4.2:** Verify Persistence (before install)
- Documents assumption: `/workspace/project/.claude/` is persistent
- Validates config location before installation
- Flags if `add-mcp` writes to wrong location (e.g., `~/.claude/`)
- Logs persistence check result in audit
- Troubleshooting section covers persistence issues

**Persistence Requirements:**
```bash
# CORRECT - Persistent location
/workspace/project/.claude/settings.json

# WRONG - Ephemeral in container
~/.claude/settings.json
```

**Verification:**
```bash
# Check mount points
mount | grep workspace

# Verify config location
ls -la /workspace/project/.claude/

# Log persistence status
{"action":"persistence_verified", "config_location":"/workspace/project/.claude/settings.json", "persistent":true}
```

**Persistence Troubleshooting:**
- Section added for config lost after restart
- Instructions to manually move config if needed
- Audit log update for persistence issues

## Workflow Changes

**Before (Original - BROKEN):**
```
1. Discover
2. Validate
3. Install
4. Test ← FAILS (tool not loaded)
5. Use ← FAILS SILENTLY
```

**After (Fixed - PRODUCTION-SAFE):**
```
Session 1:
1. Discover
2. Validate
3. Audit (BEFORE install)
4. Verify Persistence
5. Install (project-scoped only)
6. Document & STOP
   - Write mcp-servers.md
   - Create restart notice
   - Tell user to restart session

Session 2:
7. Verify loaded (claude mcp list)
8. Test basic function
9. Audit first use
10. Complete original task
11. Audit task completion
```

## File Structure

```
.claude/skills/provision-mcp/
├── SKILL.md (886 lines - complete implementation)
├── manifest.yaml (metadata)
├── README.md (architecture overview)
├── PRODUCTION-READY.md (this file)
└── SKILL.md.backup (original version)

/workspace/project/data/
└── mcp-audit.jsonl (created on first provision)

/workspace/group/
├── mcp-servers.md (created on first provision)
└── session-restart-required.txt (created after install)
```

## Security Checklist (Updated)

All installations must verify:

- [ ] Source code publicly available
- [ ] No arbitrary code execution
- [ ] No system writes without permission
- [ ] Clean dependencies
- [ ] OAuth 2.1 or API keys
- [ ] Input validation present
- [ ] Recently maintained
- [ ] Permissions match purpose
- [ ] Permissive license
- [ ] Official OR high community trust
- [ ] **✅ Audit log written BEFORE installation** (NEW)
- [ ] **✅ Project-scoped installation (NOT global)** (NEW)
- [ ] **✅ Persistence verified (config in /workspace/project/)** (NEW)

## Testing Checklist

To verify the skill is production-ready:

**Test 1: Successful Installation**
- [ ] Request task requiring missing MCP (e.g., "Create Linear ticket")
- [ ] Verify gap analysis identifies need
- [ ] Verify discovery finds appropriate server
- [ ] Verify security validation passes
- [ ] **Verify audit log created BEFORE install**
- [ ] **Verify persistence check runs**
- [ ] Verify installation uses project scope (no --global)
- [ ] Verify `mcp-servers.md` created/updated
- [ ] Verify `session-restart-required.txt` created
- [ ] **Verify agent STOPS (doesn't attempt to use tool)**
- [ ] Verify user gets restart notice
- [ ] **NEW SESSION:** Verify tool loaded
- [ ] Verify first use test succeeds
- [ ] Verify original task completes
- [ ] **Verify all audit events logged**

**Test 2: Rejected Installation**
- [ ] Request unsafe MCP server
- [ ] Verify security review detects red flags
- [ ] **Verify install_failed logged to audit**
- [ ] Verify rejection message clear
- [ ] Verify no installation attempted

**Test 3: User Approval Required**
- [ ] Request medium-risk MCP
- [ ] Verify AskUserQuestion triggered
- [ ] If approved: verify install with security_check: "medium" in audit
- [ ] If rejected: verify install_failed with reason: "user_rejected"

**Test 4: Persistence**
- [ ] Install MCP server
- [ ] Restart container
- [ ] **Verify config still present** in `/workspace/project/.claude/`
- [ ] Verify MCP still loads in new session

**Test 5: Audit Trail**
- [ ] Perform multiple installations
- [ ] Read `/workspace/project/data/mcp-audit.jsonl`
- [ ] Verify all events logged in order
- [ ] Verify timestamps, task context, security results present
- [ ] Verify JSON format valid (parseable)

## Known Limitations

1. **Requires manual session restart** - No way to reload MCPs programmatically in current session
2. **add-mcp CLI dependency** - Must be installed (handled automatically on first use)
3. **No automated rollback** - If install fails mid-process, may need manual cleanup
4. **Registry downtime** - If all registries unreachable, discovery fails
5. **Container-specific** - Persistence assumptions based on NanoClaw container mounts

## Migration from v1.0.0

If you used the original version:

1. **Check for incomplete installs:** Look for MCPs that were "installed" but never tested
2. **Review audit trail:** Original version had no audit - you may not know what was installed
3. **Verify scopes:** Check if any servers were installed globally (not recommended)
4. **Re-test all MCPs:** Ensure they work after restart (persistence issue may exist)

## Next Steps

1. **Test with safe MCP server** (e.g., official Anthropic filesystem MCP)
2. **Verify audit logging** works as expected
3. **Test session restart flow** (most critical change)
4. **Review security checklist** with your specific requirements
5. **Customize pre-validated servers list** if needed

## Support

**Issues:**
- Check `/workspace/project/data/mcp-audit.jsonl` for installation history
- Review `mcp-servers.md` for documented installations
- Check `session-restart-required.txt` if install pending restart

**Documentation:**
- [SKILL.md](./SKILL.md) - Complete implementation guide (886 lines)
- [README.md](./README.md) - Architecture and examples
- [manifest.yaml](./manifest.yaml) - Skill metadata

## Version History

**v2.0.0 (2026-02-22)** - Production-ready
- ✅ Added session restart requirement
- ✅ Enforced project-scoped installations
- ✅ Added structured audit logging
- ✅ Added persistence verification
- All four critical gaps addressed

**v1.0.0 (2026-02-22)** - Initial design
- ❌ Assumed hot-loading (broken)
- ❌ Allowed global installs (unsafe)
- ❌ No audit trail (blind)
- ❌ Persistence not verified (risky)
