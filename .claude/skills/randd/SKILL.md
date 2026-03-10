# Skill: /randd

R&D pipeline skill with two modes: research and plan.

---

## Mode A — New Research (`/randd research`)

Creates a new research document in `randd/research/`.

### Steps

1. **Interview** — Ask 3–5 questions to scope the research:
   - What is the topic or problem?
   - What's driving this — what broke, what's missing, what's being considered?
   - Which nanoclaw systems or files are most relevant?
   - What kind of output is needed: options survey, decision recommendation, architecture doc?
   - Any constraints or non-starters to document?

2. **Gather** — Read relevant nanoclaw files based on the answers. Use web fetch if external references are needed. Pull from existing research docs if related topics exist in `randd/research/`.

3. **Write** → `randd/research/YYYY-MM-DD-{slug}.md`

### Research Doc Format

```markdown
# Research: {Topic}

**Date:** YYYY-MM-DD
**Status:** Open

## Problem / Why We're Looking At This

## Key Findings

## Options / Approaches

## Open Questions

## Sources
```

---

## Mode B — Promote to Plan (`/randd plan`)

Promotes a research doc to an implementation-ready plan in `data/sessions/main/.claude/plans/`.

### Steps

1. **Select** — List all files in `randd/research/`. Ask the user which one to promote (or confirm if they named it).

2. **Interview** — Ask 3–5 questions to shape the plan:
   - Which approach or option from the research should be implemented?
   - Any constraints on scope, dependencies, or order of operations?
   - What does "done" look like — what's the verification step?
   - Should Thomas run this autonomously, with supervision, or jointly with Joel?
   - Any parts that should be excluded from this plan and deferred?

3. **Write** → `data/sessions/main/.claude/plans/YYYY-MM-DD-{slug}.md`

### Plan Doc Format

```markdown
# Plan: {Title}

**Date:** YYYY-MM-DD
**Executor:** Thomas (autonomous | supervised | joint)
**Estimated Weight:** light | medium | heavy
**Status:** Ready to implement

## Context

Brief summary of why this is being built and what research it's based on.

## Scope

**In:**
- ...

**Out (deferred):**
- ...

## Implementation Steps

1. ...
2. ...

## Files Modified

- `path/to/file` — what changes

## Verification

How to confirm this worked. Include specific commands or checks.

## On Success

Move this plan to `/workspace/project/randd/completed/YYYY-MM-DD-{slug}.md`.

## On Failure

Write a summary to `/workspace/project/randd/backlog/YYYY-MM-DD-{slug}-followup.md`.
Include a `blocked_by` field identifying what must be resolved before retrying.

### Backlog Entry Format

**blocked_by:** {description of what's blocking — missing dependency, failed test, unresolved question, etc.}
```

---

## Notes

- The plans path (`data/sessions/main/.claude/plans/`) is mounted inside Thomas's container at `/home/node/.claude/plans/`. Plans written here are picked up automatically at session start.
- Research docs in `randd/research/` are reference only — Thomas does not act on them directly.
- `randd/backlog/` is written by Thomas after failed or incomplete plan execution. Joel reviews before next cycle.
