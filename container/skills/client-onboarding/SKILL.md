# Skill: client_agent_onboarding

## Purpose

A repeatable process for onboarding new clients into their own executive agent build via Arthur & Archie. Used when a prospect or new client has been introduced and needs a clear, low-friction path from first contact to working system.

## Trigger

Joel introduces a new client (by email, Telegram, or standing order) with context about who they are and what they need.

## What We Know So Far (from Stephen Feng Test)

### Initial Contact Pattern
- Client is reached via email
- Thomas sends first outreach as AI Executive Assistant (NOT "Joel and I work together")
- The intro positions Thomas as the product demo — "I am Joel's Executive Assistant, exactly what we want to build for you"

### Assets Sent in First Email
1. *AGENT.md schema* — Maps out the client's proposed agent environment. Attached to the email thread.
2. *Onboarding microsite* — Step-by-step schedule (e.g., Netlify-hosted). Includes access code if needed.

### Tone and Framing
- Honest about AI nature (disclosure note at bottom)
- Positions deliverables as drafts to invite input
- Low pressure — "no rush, no format requirements"

### AI Chat Prompt Invitation
After flagging deliverables as drafts, include:

> "Feel free to drop this content into an AI chat session if you like with this prompt:
>
> 'I am building my own executive agent. Here is how my AI engineering partners suggest I get started. Interview me to see if this is the best fit and how I can improve the plan.'
>
> Then bring me the full output from that session."

This serves dual purpose: (1) qualifies the client's AI readiness, (2) generates structured context Thomas can use to customize the build plan.

### Open Questions to Collect
- What would the client change, cut, or add to the schema?
- Name for mock company (used to generate test environment)
- Anything that feels off about workflow framing

## Step-by-Step Process

1. *Receive client intro* from Joel with name, company, context
2. *Generate AGENT.md schema* — Use known context to draft agent environment map
3. *Build or clone onboarding microsite* — Populate with client-specific steps
4. *Draft first email* — Use approved copy pattern above
5. *Send for Joel's review* (or auto-send if standing order exists for that client)
6. *Wait for client reply* — Log anything received in memory
7. *Process AI chat output* if client returns a session transcript — summarize and surface to Joel
8. *Iterate schema and plan* based on client input

## File References
- `/workspace/group/memory/stephen-feng-onboarding-email.md` — Approved email copy for Feng engagement
- Contact object: `/workspace/project/contacts/stephen-feng/state_index.json`
- Opportunity object: `/workspace/project/opportunities/lilly-feng-personal-enablement/state_index.json`
- ⚠️ OLD PATH (deprecated): `/workspace/project/groups/main/memory/graph/eli-lilly.md`

## Status
- First test: Stephen Feng (Eli Lilly context)
- v1 email sent 2026-03-01
- v2 copy approved by Joel 2026-03-01
