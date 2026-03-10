# Web Decoder Skill

## Trigger
- "Decode this URL" / "Decode these URLs"
- "Reverse engineer this form/page/flow"
- "Extract the structure from [URL]"
- "Plan a decode for [URLs]"
- Any request to reverse-engineer web sources into structured reference files

## Purpose
Two-stage system for reverse-engineering web sources (forms, assessments, screenflows, apps) into structured reference files. Stage 1 plans, Stage 2 executes.

## Mode Detection
- If Joel says "plan a decode" or "set up a decode" → **Stage 1: Planning**
- If Joel says "run the decode" or points to an execution file → **Stage 2: Execution**
- If Joel just gives URLs with "decode these" → **Default to Stage 1 first**

---

## Stage 1: Planning

### Round 1: Source Inventory
Gather from Joel (ask naturally, not as a rigid questionnaire):
1. **URLs** — every source to be decoded
2. **Source context** — what is each URL? (form, assessment, app, etc.)
3. **Access** — public? auth required? credentials available?
4. **Relationships** — are sources related? (steps in same flow, different views, etc.)
5. **Output goal** — recreation, migration, reference, audit, content rewrite?

### Round 2: Automated Recon (no user involvement)
For each URL:
1. Fetch the URL with WebFetch
2. Classify: static page, Google Form, JS-rendered app, multi-step form, branching assessment, authenticated app
3. Detect: single vs multi-step, linear vs branching, dynamic content, anti-bot protections
4. Check for direct API access (form IDs, visible endpoints)

### Round 3: Tool Selection
For each source classification:
- **Static pages**: Firecrawl MCP (`mcp__firecrawl__firecrawl_scrape`) — fastest for public content. Fallback: WebFetch
- **Google Forms**: Google Forms API via Bash curl (if form ID extractable)
- **JS-rendered / interactive**: agent-browser (Playwright/Chromium, built into container). Alternative: Playwright MCP (`mcp__playwright__*`) for structured extraction with schema
- **Authenticated apps**: agent-browser with manual login or saved auth state
- **API-backed**: direct API calls via Bash
- **Multi-page scrape**: Firecrawl search (`mcp__firecrawl__firecrawl_search`) or map (`mcp__firecrawl__firecrawl_map`)

Rule: Prefer Firecrawl for static/public content. Use browser tools only when JS rendering or interaction is required.

### Round 4: Generate Execution File
Write a self-contained execution file to `/workspace/group/decoded/web-decoder-exec-{date}.md` containing:
- Mission statement
- Source list with classifications, tools, and extraction strategies
- Tool configuration
- Output specification
- Execution rules

Ask Joel: "Save and launch, or save for later?"

---

## Stage 2: Execution

Process the execution file (or URLs directly if no plan).

### Phase 1: Setup
- Read execution file
- Create output directory structure
- Verify tools
- Create empty gaps.md

### Phase 2: Extraction (in order: API → static → interactive)

**Static pages (WebFetch / Firecrawl):**
- Fetch content, extract copy/metadata/structure

**Interactive sources (agent-browser):**
```bash
agent-browser open <url>
agent-browser snapshot -i -c    # see interactive elements
agent-browser click @e5         # navigate through flow
agent-browser screenshot        # capture each state
```
- Systematically explore every screen, step, and branch
- Document each state before interacting
- For branching flows: explore ALL branches

**API sources:**
- Hit endpoints directly via curl
- Capture full structured response

### Phase 3: Output Files (per source)

**content.md** — All visible copy organized by page/step/section
- Every piece of text: labels, instructions, help text, errors, placeholders, buttons, footers
- Exact copy — do not paraphrase
- Conditional content with trigger conditions

**fields.json** — All form fields with metadata
```json
{
  "source_url": "...",
  "total_fields": 0,
  "pages": [{
    "page_id": "page_1",
    "fields": [{
      "field_id": "...",
      "label": "...",
      "type": "text|select|radio|checkbox|...",
      "required": true,
      "options": [{"value": "...", "label": "...", "score": null}],
      "conditional_visibility": {"depends_on": "...", "condition": "equals", "value": "..."}
    }]
  }]
}
```

**structure.json** — Flow structure and branching logic
```json
{
  "flow_type": "linear|branching|conditional|single_page",
  "steps": [{
    "step_id": "step_1",
    "navigation": {
      "next": "step_2",
      "branches": [{"condition": "...", "destination": "step_3"}]
    }
  }],
  "completion": {"submit_action": "...", "confirmation_content": "..."}
}
```

**meta.json** — Extraction metadata (tool used, completion status, errors)

**assets/** — Downloaded images, PDFs, media

### Phase 4: Validation
- Verify each source has all output files
- Check content.md has actual copy (not empty)
- Update gaps.md with any incomplete extractions

### Phase 5: Manifest
Create manifest.md at output root:
- Sources processed, success/failure counts
- Table: source, type, tool, status, field count, page count
- File tree of everything generated
- Gap summary

## Error Handling
- Tool not available → use fallback → if no fallback, log gap, continue
- Auth failure → log, continue with other sources
- Anti-bot block → log block type, try alternative tool, continue
- Timeout → retry once, then log gap, continue
- **Never stop the entire run because one source fails**

## Output Location
All output goes to `/workspace/group/decoded/{run-name}/`
