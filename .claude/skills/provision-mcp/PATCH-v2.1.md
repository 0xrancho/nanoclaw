# provision-mcp v2.1 - Architecture Corrections

**Date:** 2026-02-23T00:45:00Z
**Previous Version:** 2.0.0
**Status:** Patched per Joel's corrections

## Changes Applied

### 1. ✅ Removed Global Install Restriction

**Previous (v2.0.0):**
- Forbidden `--global` flag
- Enforced project-scoped installs only
- Treated global installs as security risk

**Corrected (v2.1):**
- Container isolation makes global/local equivalent
- Use whatever method the MCP server recommends
- Install methods: global npm, local npm, npx, or remote
- Choose based on MCP server's documentation, not arbitrary policy

**Rationale:**
> npm global installs inside a container are already isolated by the container boundary. Scoping to project-local is unnecessary overhead.

### 2. ✅ Sub-Agent Respawn Pattern

**Previous (v2.0.0):**
- Install → Document → Stop → User restarts session → Retry task
- User-facing gate for every install
- Workflow interrupted for technical limitation

**Corrected (v2.1):**
- Install → Spawn sub-agent with updated config → Continue task
- Fully transparent in headless operation
- Only interactive Claude Code sessions require manual restart
- Sub-agent pattern: `spawnAgent({ reloadMCPConfig: true })`

**Rationale:**
> Session restart is an internal orchestration step, not a user gate. In headless operation, the principle agent handles this itself.

**Implementation:**
```typescript
// Pseudo-code for Phase 7
const subAgent = spawnAgent({
  task: originalTaskDescription,
  context: { newMCP: installedServerName },
  reloadMCPConfig: true  // Force config reload
});
await subAgent.execute();
```

### 3. ✅ Project Profile Governance

**Previous (v2.0.0):**
- Trust levels (high/medium/low) determined user prompting
- Security review drove decision to ask user
- No governance layer

**Corrected (v2.1):**
- **NEW Phase 0:** Check Project Profile (FIRST)
- Project profile determines auto vs supervised mode
- Trust levels inform security review, NOT user prompting
- Default: supervised mode (until profiles implemented)

**Profile Structure:**
```json
{
  "mode": "auto" | "supervised",
  "mcp_provisioning": {
    "enabled": true,
    "auto_install": true,
    "allowed_registries": ["smithery", "lobehub", "npm"],
    "require_approval_for": ["community", "write_access"],
    "max_trust_level": "medium"
  }
}
```

**Decision Flow:**
```
Phase 0: Check profile
  ↓
Auto mode?
  YES → Install transparently, spawn sub-agent, continue
  NO  → Get user approval, then install + spawn sub-agent
```

**Rationale:**
> The only gate is the project profile. Before any provisioning action, the skill must check the project's governance profile. This replaces the current trust-level logic as the primary decision point.

## Workflow Comparison

### OLD (v2.0.0) - User-Gated

```
Session 1:
1. Discover
2. Validate (trust level → prompt if medium)
3. Audit
4. Install (project-scoped only)
5. Document & STOP
6. Tell user: "Restart required"

Session 2:
7. User manually restarts
8. User retries task
9. Complete task
```

### NEW (v2.1) - Profile-Driven

```
AUTO MODE (Headless):
1. Check profile → auto mode
2. Discover
3. Validate (trust level for security only)
4. Audit
5. Install (use MCP's recommended method)
6. Spawn sub-agent (reloadMCPConfig=true)
7. Sub-agent completes task
8. Return result (transparent to user)

SUPERVISED MODE (Interactive):
1. Check profile → supervised mode
2. Discover
3. Validate
4. Ask user approval
5. Install
6. Spawn sub-agent OR tell user to restart (if interactive session)
7. Complete task
```

## Key Architectural Principles (NEW)

**Container Isolation**
- npm global installs inside containers are isolated
- Use recommended install method (npx/global/local/remote)
- Container boundary provides scope

**Headless Operation**
- Install → Spawn sub-agent → Continue (no user interruption)
- Only interactive Claude Code sessions need manual restart

**Project Governance**
- Profile determines auto vs supervised
- Trust levels inform security, NOT prompting
- Default: supervised mode until profiles exist

**Audit Trail**
- Still required before every install
- Now includes `mode` and `user_approved` fields

## Files Modified

**SKILL.md**
- Added Phase 0: Check Project Profile
- Removed global install restrictions
- Added sub-agent spawn pattern (Phase 7.2)
- Updated workflow examples
- Added project profile reference section

**Audit Log Format (Updated)**
```json
{
  "mode": "auto" | "supervised",
  "user_approved": true | false | null,
  "install_method": "global" | "local" | "remote" | "npx"
}
```

## Migration Notes

**From v2.0.0 to v2.1:**

1. **Global installs now allowed:**
   - Remove any restrictions on `--global` flag
   - Follow MCP server's recommended install method

2. **Check profile first:**
   - Read `/workspace/project/.nanoclaw/profile.json`
   - Default to supervised mode if missing
   - Respect `mode` and `auto_install` settings

3. **Spawn sub-agents:**
   - In headless context: spawn sub-agent after install
   - In interactive context: user still restarts manually
   - Sub-agent gets `reloadMCPConfig: true` flag

4. **Trust levels changed:**
   - HIGH/MEDIUM/LOW still exist for security review
   - NO LONGER determine user prompting
   - Project profile determines prompting

## Testing Checklist (Updated)

- [ ] Profile reading works (Phase 0)
- [ ] Auto mode: installs transparently
- [ ] Supervised mode: asks user first
- [ ] Global npm installs work
- [ ] Sub-agent spawn pattern works (headless)
- [ ] Audit log includes mode and approval fields
- [ ] Trust levels still gate security (not prompts)
- [ ] Default supervised mode when no profile

## Backward Compatibility

**Breaking Changes:**
- Trust levels no longer control user prompting (profile does)
- Global installs now allowed (previously forbidden)
- Workflow doesn't stop after install in auto mode

**Non-Breaking:**
- Audit log format extended (new fields, old ones remain)
- Security validation unchanged
- Registry search unchanged

## Future Work

**When project profiles are implemented:**
- Create `/workspace/project/.nanoclaw/profile.json` schema
- Implement profile validation
- Add profile management commands
- Document profile best practices per project type

**Sub-agent spawn implementation:**
- Currently pseudo-code in SKILL.md
- Needs actual implementation in container-runner
- Should handle config reload gracefully
- Must pass context to sub-agent

## Summary

The skill is now architected correctly:

1. **Container scope** = install method doesn't matter (global OK)
2. **Session restart** = internal orchestration (sub-agent spawn)
3. **User gate** = project profile (auto vs supervised)

This makes provisioning:
- **Transparent** in auto mode (no user interruption)
- **Governed** by project policy (not arbitrary trust levels)
- **Flexible** in install methods (use what MCP recommends)

All changes applied and documented.
