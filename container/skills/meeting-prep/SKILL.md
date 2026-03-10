# Meeting Prep Skill

## Trigger
- "Prep me for my meeting with [person/company]"
- "Meeting prep for [name]"
- "I have a call with [name] — what should I know?"
- Any request to prepare for an upcoming meeting or call

## Purpose
Research a contact and/or company, pull CRM context, assess the relationship, and generate a concise brief with talking points, positioning, and asks. Deliver via Telegram.

## Execution Steps

### Step 1: Parse the Request
Extract from Joel's message:
- **Contact name** (if provided)
- **Company name** (if provided)
- **Meeting context** (what it's about, if mentioned)
- **Urgency** (when is the meeting?)

If both contact and company are missing, ask Joel for at least one.

### Step 2: CRM Lookup (Airtable)
Check Airtable for existing relationship context:

```bash
curl -s "https://api.airtable.com/v0/appcO9EN2MWwrcs6E/Opportunities" \
  -H "Authorization: Bearer $MASTER_COMMIT_PAT" \
  -H "Content-Type: application/json" | head -200
```

Search for the contact or company name in the pipeline. Extract:
- Deal stage and value
- Last interaction date
- Notes or history
- Related contacts

Also check your memory files for any past context on this person/company.

### Step 3: Web Research
Run parallel research:

**Contact research:**
```
WebSearch: "[contact name] [company] LinkedIn"
WebSearch: "[contact name] [company] role background"
```

**Company research:**
```
WebSearch: "[company name] about"
WebSearch: "[company name] recent news 2026"
```

If Firecrawl is available, scrape the company website for deeper context:
- Value proposition
- Services offered
- Team page (find the contact's role)
- Recent blog posts or news

If Apollo API is available, enrich the contact:
```bash
curl -s "https://api.apollo.io/v1/people/match" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $APOLLO_API_KEY" \
  -d '{"name": "[contact name]", "organization_name": "[company]"}'
```

### Step 4: Assess Relationship
Based on CRM data and research, classify:
- **Relationship type**: Cold / Warm intro / Existing relationship / Referral
- **Stage**: First meeting / Follow-up / Proposal review / Ongoing engagement
- **Decision authority**: Buyer / Influencer / End user / Gatekeeper
- **A&A fit**: How well does this match Arthur & Archie's ICP?

### Step 5: Generate Brief
Compile into a concise brief. Use Telegram formatting:

```
*Meeting Prep: [Contact] — [Company]*

*Who They Are*
• [Role, background, 2-3 key facts]
• [Company: what they do, size, industry]

*Relationship Context*
• [CRM stage, history, last touch]
• [How they found us / who referred]

*What They Care About*
• [Pain points or interests from research]
• [Recent news or initiatives]

*Positioning*
• [Which A&A service/approach fits]
• [Relevant portfolio piece or case study]
• [Key differentiator to emphasize]

*Talking Points*
• [2-3 specific things to bring up]
• [Questions to ask them]

*Ask*
• [What Joel should aim to achieve in this meeting]
• [Specific next step to propose]

*Watch For*
• [Potential objections or sensitivities]
• [Things to avoid]
```

### Step 6: Deliver
Send the brief via `mcp__nanoclaw__send_message` so Joel gets it immediately.

If the brief is long, send a summary first then the full brief.

## Degraded Mode
If tools aren't fully provisioned yet, the skill still works:
- **No Airtable**: Skip CRM lookup, note "CRM context unavailable"
- **No Apollo**: Skip contact enrichment, rely on web search
- **No Firecrawl**: Use WebFetch for basic page scraping
- Always have: WebSearch, WebFetch, memory files, conversation history

## Post-Meeting: Document Generation

After a meeting, Joel may say "write up the What We Heard" or "generate the follow-up doc." This triggers the doc generation pipeline.

### What-We-Heard Document

A branded HTML artifact sent to the prospect after a discovery meeting. It reflects back what they said, positions A&A's approach, and proposes next steps. The template lives at `templates/what-we-heard-sample.html` in this skill directory — study it before generating.

### Document Structure

The HTML doc follows this exact structure:

1. **Password Gate** — Optional. Overlay with logo, "Confidential Document" label, password input. Set password to something contextual (meeting location, project name, etc.).

2. **Header** — Dark charcoal bar with logo (left) and doc type + date (right).

3. **Title Block** — Client label (uppercase, blue), display heading (Fraunces font), meeting context line (date, location).

4. **Meeting Meta Grid** — 2x2 grid on light background: Date, Location, Client Attendees, A&A Attendee.

5. **Executive Summary** — Blue left-border callout. 2-3 sentences capturing the core opportunity and what the prospect is trying to achieve.

6. **What We Heard** — Numbered theme cards (blue or amber left-border). Each has: priority label, title, 2-3 sentence description of what the prospect shared. Use their language. 3-5 themes typical.

7. **Your Goals** — Amber-bulleted priority list. Pull directly from what they said. Specific, quantified where possible.

8. **Suggested Approach** — 2-column grid:
   - **Primary card** (dark charcoal background, amber label): "Recommended Starting Point" — usually a constrained sprint or POC
   - **Secondary card** (light background, blue label): "Full Scope Option" — the bigger engagement
   - Follow with 1-2 sentences explaining why you recommend starting small.

9. **Next Steps** — Action items with owner (A&A / Client / Joint), description, and timeline.

10. **Contact Card** — Joel's photo, name, role, email. Avatar at `assets/team/joel2.png`.

11. **Footer** — Dark charcoal bar with logo and tagline.

12. **Confidential Strip** — Narrow dark bar: "Prepared exclusively for [Client] · Confidential"

### Design Tokens (CSS Custom Properties)

```css
--ci-blue: #1DA1D4;
--ci-blue-dark: #1789B5;
--ci-amber: #F2B35E;
--ci-charcoal: #3A4A54;
--ci-charcoal-deep: #2E3C44;
--ci-white: #ffffff;
--ci-light: #f5f7f8;
--ci-border: #e2e7ea;
--ci-text: #3A4A54;
--ci-text-light: #6B7D88;
--font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-display: 'Fraunces', Georgia, serif;
```

Google Fonts import: `Inter:wght@300;400;500;600;700` and `Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400;1,9..144,600`

### Branding Note

Current brand is **Commit Impact** (logo, colors, tagline "Commit to impact."). This is transitioning to **Arthur & Archie**. Use whichever brand Joel specifies. The CSS tokens and template structure work for either — just swap logo, company name, tagline, and contact email.

### Asset Paths

When generating docs, reference assets relative to the output directory:
- Logos: `assets/logos/logo-vector.png` (primary), `logo-dark.png`, `logo-light.png`
- Team photo: `assets/team/joel2.png`

Copy assets from this skill's directory into the output directory alongside the HTML.

### Generation Workflow

1. Joel says "write up the What We Heard for [client]" (or similar)
2. Pull meeting context from:
   - The conversation (Joel may have shared notes or dictated key points)
   - Meeting prep brief (if one was generated earlier)
   - CRM/pipeline data from Airtable
   - Any research already done on the contact/company
3. Read `templates/what-we-heard-sample.html` as the structural reference
4. Generate a new HTML file with the client's content populated into the template structure
5. Copy the full CSS from the sample template — do not simplify or modify styles
6. Write the HTML file to the group's output directory
7. Copy branding assets alongside it
8. Send Joel a Telegram message with a summary of what was generated and where to find it

### Writing Style for the Document

- **Reflect, don't sell.** The doc should feel like a mirror of what they said, with professional framing. Not a pitch deck.
- **Use their language.** If they said "we need to 2x proposal output," write that — don't paraphrase into corporate speak.
- **Be specific.** Reference their tools (SharePoint, Deltek, Monday.com), their numbers (40% automation target), their people (by name and role).
- **Position through structure.** The suggested approach section does the selling — the rest just demonstrates you listened.
- **Keep it tight.** Each theme card is 2-3 sentences. The exec summary is 2-3 sentences. No filler.

## Quality Standards
- Be specific, not generic. "They just raised a Series B" beats "they're growing."
- Connect research to A&A's positioning. Don't just dump facts — make them actionable.
- Keep it scannable. Joel reads this on his phone before the meeting.
- If you can't find much, say so honestly. "Limited public info — suggest opening with discovery questions."
