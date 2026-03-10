# Morning Briefing Skill

## Trigger
- "Set up my morning briefing"
- "Start daily briefings"
- "Morning briefing"
- Also runs automatically when registered as a scheduled task

## Purpose
Deliver a concise daily briefing to Joel every weekday morning. Covers calendar, email, pipeline, and a closing reflection.

## Scheduled Activation
Register this as a cron task:
```
schedule_task(
  prompt: "Run the morning briefing skill. Check calendar, email, pipeline, and deliver a concise briefing.",
  schedule_type: "cron",
  schedule_value: "30 7 * * 1-5",
  context_mode: "group"
)
```
This runs weekdays at 7:30 AM (server timezone).

## Execution Steps

### Section 1: Calendar Overview
*Requires: Google Calendar API (pending setup)*

If available:
- Pull today's meetings and events
- Flag any meetings in the next 2 hours
- Note any prep needed (trigger Meeting Prep skill if meeting is within 4 hours)

If not available:
- Skip with note: "Calendar not connected yet."

### Section 2: Email Scan
*Requires: Gmail MCP*

If available:
```
mcp__gmail__search_emails: "is:unread newer_than:1d"
```
- Count unread emails
- Flag any from known contacts (check memory/CRM)
- Flag any with urgent keywords (urgent, asap, deadline, invoice, payment)
- Summarize top 3-5 by importance

If not available:
- Skip with note: "Gmail not connected yet."

### Section 3: Pipeline Summary
*Requires: Airtable API (MASTER_COMMIT_PAT)*

If available:
```bash
curl -s "https://api.airtable.com/v0/appcO9EN2MWwrcs6E/Opportunities" \
  -H "Authorization: Bearer $MASTER_COMMIT_PAT" | head -500
```
- Count deals by stage (Active, Proposal, Presales, Qualification)
- Flag anything that changed since yesterday (if memory has yesterday's snapshot)
- Flag stalled deals (no activity in 7+ days)
- Total pipeline value

If not available:
- Skip with note: "Airtable not connected yet."

### Section 4: Reflection
Pick ONE of these based on the day and context:
- A relevant insight from Joel's past conversations (search memory)
- A strategic question about the pipeline
- A reminder of something Joel said he wanted to follow up on
- A theological or systems-thinking reflection that connects to the day's work

Keep it to 1-2 sentences. Not performative. Genuine.

## Output Format (Telegram)

```
*Good morning, Joel.* ☀️

*Calendar*
• [meeting summary or "no meetings today"]

*Email*
• [X unread — highlights]

*Pipeline*
• [stage counts, total value, flags]

*Today's thought*
[reflection]
```

## Progressive Enhancement
The briefing starts with whatever tools are available and gets richer as tools come online. Each section checks for its dependency and gracefully degrades. This means the briefing works from day one — even if it's just the reflection.

## Memory
After each briefing:
- Save a snapshot of pipeline state to `memory/pipeline-snapshots/{date}.json` (for change detection)
- Note any flags or follow-ups in `memory/briefing-flags.md`
