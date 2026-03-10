# Tool Discovery Skill

## Trigger
- "What tool should I use for X"
- "Find an MCP for X"
- "I need a tool that can..."
- Any situation where current tools are insufficient for a task

## Purpose
Find, validate, and optionally install MCP servers, CLIs, or libraries needed for a task. You are empowered to discover AND provision open-source tools autonomously. Report what you add.

## Search Methodology (execute all steps in one pass)

### Step 1: Parse the Process
Break down what's needed into:
- **Input**: What data or access is available
- **Transformation**: What needs to happen
- **Output**: What the deliverable looks like
- **Constraints**: Auth, format, volume, local vs cloud

### Step 2: Check Known Tools
Review what's currently available in your environment:
- Built-in: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task
- MCP servers: nanoclaw, gmail, calendar, gdrive, firecrawl, playwright
- Container tools: agent-browser (CLI, Playwright/Chromium)
- API keys available: FIRECRAWL_API_KEY, APOLLO_API_KEY, MASTER_COMMIT_PAT (Airtable)

Key MCP tool prefixes:
- `mcp__firecrawl__*` — Web scraping, crawling, search, structured extraction
- `mcp__playwright__*` — Headless browser automation, screenshots, structured page interaction
- `mcp__gmail__*` — Email read/send/search/labels/filters
- `mcp__calendar__*` — Google Calendar events
- `mcp__gdrive__*` — Google Drive file access

If an existing tool covers the need, use it. Don't add new tools unnecessarily.

### Step 3: Search MCP Directories
Search these sources in order using specific technical terms (not broad terms like "AI tool"):

1. **https://mcp.so** — community MCP registry
2. **https://smithery.ai** — curated MCP directory
3. **https://glama.ai/mcp** — MCP directory
4. **https://github.com/punkpeye/awesome-mcp-servers** — curated list
5. **https://github.com/modelcontextprotocol** — official MCP org
6. **https://github.com/topics/mcp-server** — GitHub topic

Search at least 3 directories before concluding.

### Step 4: Validate on GitHub
For every candidate:
- Fetch the GitHub repo
- Check: stars, last commit date, open issues, README quality
- Flag anything with no commits in 90+ days as "potentially stale"
- Flag anything with < 50 stars as "early stage"

### Step 5: Anti-Pattern Check
Before recommending:
- Never recommend raw browser automation libraries without an MCP wrapper
- Prefer smart browser wrappers (agent-browser, Browserbase Stagehand) over thin wrappers
- Never recommend tools with 90+ day staleness without flagging it
- Before recommending browser automation, check if a direct API exists
- Don't recommend generic AI agent frameworks (LangChain, CrewAI, etc.)
- Check if a tool already in your stack covers this with different configuration

### Step 6: Recommend and Optionally Install

**Output Format:**

*Process Breakdown:*
- Input: ...
- Transformation: ...
- Output: ...

*Recommended Tools:*

| Tool | Type | What It Does | GitHub Activity | Confidence |
|------|------|-------------|----------------|------------|
| name | MCP/CLI/Library | description | stars / last commit | High/Med/Low |

*Why These Tools:* rationale for each pick

*Known Limitations:* gotchas to watch for

**If the tool is open-source and clearly fits:**
- Install it (npm install, pip install, etc.)
- Configure it as an MCP server if applicable
- Test that it works
- Report what was installed and how to use it
- Note it in your memory for future reference

**If uncertain about fit or it's a paid service:**
- Present the recommendation to Joel
- Wait for confirmation before installing

## Rules
- Always give at least a primary and an alternative recommendation
- If nothing good exists, say so explicitly
- Execute all steps in one pass — no pausing mid-methodology
- After installing a new tool, update your memory with what was added
