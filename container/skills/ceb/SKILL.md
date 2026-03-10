# CEB (Client Experience Brief) Skill

## Trigger
- "Run CEB interview" / "Generate a brief"
- "Run CEB with [persona]" (test mode)
- "CEB for [company/contact]"

## Purpose
Conducts a 10-step interview to collect inputs for a Client Experience Brief, then generates a multi-section HTML brief. Uses deterministic logic for classification and AI synthesis for narrative sections.

## Prerequisites
This skill requires access to the agenticforms directory, which should be mounted at `/workspace/extra/agenticforms/`. If not mounted, tell Joel:
> "CEB needs the agenticforms directory mounted. Ask Joel to add it as an additional mount for the main group."

Key paths (all relative to `/workspace/extra/agenticforms/`):
- `ceb/config/` — form-types.json, constraints.json, heuristics.json, growth-stages.json, pre-classification.json, current-state-rules.json, form-jobs.json, thesis-grammar.json, pricing.json
- `ceb/prompts/` — adaptive-step2.md, adaptive-step4.md, adaptive-step7.md, adaptive-step8.md, constraint-reframe.md, growth-thesis.md, agentic-spec.md, success-architecture.md, sample-card-generator.md
- `ceb/schemas/` — TypeScript interfaces for inputs, outputs, scraping, enrichment
- `ceb/templates/` — brief-v3.html, sample-card.html
- `ceb/test/personas/` — test persona JSON files
- `ceb/output/` — output directory for generated briefs
- `ceb/memory/` — memory store for learning loop

## Mode Detection
- Invoked with a persona name → **test mode** (auto-fill from persona data)
- Otherwise → **live mode** (interactive interview)

---

## Live Mode Interview Flow

### Step 0: Gate
> Let's build your Client Experience Brief. Two minutes. Ten questions.
> What's your name? What's your company email?

Collect name and email. Extract domain. Initialize state. Dispatch site scraper in background.

### Step 1: FORM Type Selection
> *Where does your client experience break down?*

Present 4 options (allow multi-select, ask which is primary if multiple):
- "The right people don't find us" (ATTRACT)
- "Deals stall or die in the pipeline" (CONVERT)
- "Starting new clients is slow and manual" (ACTIVATE)
- "We leave money on the table with existing clients" (EXPAND)

Then present 3 FORM Cases for the selected type from `form-types.json`. Ask for reaction in their own words.

### Step 2: Adaptive Follow-ups
Call AI with `adaptive-step2.md` prompt + collected inputs. Present generated questions. Simultaneously show enrichment confirmation if available.

### Step 3: Audience
Pre-populate from `form_case.audience_default`. Present as confirmation.

### Step 3b: Revenue Mix
> Roughly what percentage of revenue comes from existing vs new clients?

Options: Mostly new (<30%), Mixed (30-60%), Mostly existing (>60%)

### Step 4: Strategic Thesis (Adaptive)
Run pre-classification first. Call AI with `adaptive-step4.md` + pre-classification + constraint_priors. Detect reframes.

### Step 5: Value Proposition
> In a sentence or two, what does your company actually deliver? Not your tagline — the thing your best clients would say you do.

### Step 6: Success Metrics + Internal Beneficiary
Multi-select metrics. Then ask who on the team benefits most (the daily user, not just the buyer).

### Step 7: Artifact Vision (Adaptive)
Present artifact examples from `form_case.artifact_spec` + heuristic. Call AI with `adaptive-step7.md`.

### Step 8: Current State (Adaptive)
Present industry-calibrated pattern options from heuristic. Call AI with `adaptive-step8.md`.

### Step 9: Success Narrative
> Three months after launch, what would tell you this was worth it? Not metrics — the story.

### Step 10: Generate Brief
Run deterministic logic → write state → dispatch brief generator → report results.

---

## Deterministic Logic (runs after interview)

### Growth Stage
`employee_count` → `growth-stages.json`: 1-19 scaling, 20-75 midmarket, 76+ established

### Current State Category
Step 8 input → `current-state-rules.json`: none, generic, partner_dependent, inconsistent

### Constraint Classification
Score 5 constraint types from `constraints.json` against collected indicators. Highest wins. Revenue mix > 50% existing boosts trapped_knowledge and data_asymmetry.

### Value Prop Delta
Compare Step 5 stated vs scraped value prop. Classify alignment.

### Form Job
`constraint_type` → `form-jobs.json` → form_job + description

### Pricing
`form_case` → `pricing.json` → engagement path estimates

---

## Sub-Agent Dispatch

### Site Scraper (background, after Step 0)
Dispatch via Task tool:
- Scrape company website for value prop, services, brand assets, CTA audit
- Uses Firecrawl (if available) or WebFetch + agent-browser
- Writes to `ceb/output/{slug}/scrape.json`

### Research Agent (background, after Step 0)
Dispatch via Task tool:
- Enrich company/person data via web search and Apollo
- Classify sub-industry against heuristics.json
- Writes to `ceb/output/{slug}/enrichment.json`

### Brief Generator (after Step 10)
Dispatch via Task tool:
- Reads inputs.json + scrape.json + all config files
- Generates 4 sections + sample card via AI synthesis
- Assembles final HTML using brief-v3.html template
- Writes to `ceb/output/{slug}/brief.html`

### Memory Agent (after brief generation)
Dispatch via Task tool:
- Stores interview payload to `ceb/memory/interviews/{slug}.json`
- Updates index.json
- Every 4 interviews: runs synthesis → patches config → writes report

---

## Test Mode
When invoked with a persona name:
1. Load persona from `ceb/test/personas/{name}.json`
2. Auto-fill all interview steps from persona data
3. Run deterministic logic
4. Generate brief
5. Report results vs expected values

---

## Error Handling
- If agenticforms mount is missing, stop and tell Joel
- If scrape fails, proceed without — brief adapts
- If AI synthesis fails, retry once, then write placeholder
- Always write brief.html even if some sections fail
- If sample card generation fails, render placeholder

## Output Location
All output goes to `/workspace/extra/agenticforms/ceb/output/{company-slug}/`
