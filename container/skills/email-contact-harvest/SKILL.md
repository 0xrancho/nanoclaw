# Email Contact Harvest

## Trigger
- `/harvest-contacts` or "harvest email contacts"
- Run once after email architecture deployment, then on demand or monthly

## Purpose
Populate `data/email-contacts.json` with known human contacts and VIP classifications.

## Steps

### 1. Pull from Airtable
Query all contacts across CRM tables using `$MASTER_COMMIT_PAT`:
- Contacts table (tblDZizjuAgussrNO)
- Opportunities table (tblmyHyt3DKOIRuj1)

Extract: email, name, company, relationship stage, Airtable record ID.

### 2. Pull from Gmail
Search across thomas@commitimpact.com sent mail and inbox for unique human sender addresses:
```bash
# Use Gmail MCP tools
mcp__gmail__search_emails with query "in:sent" (extract To: addresses)
mcp__gmail__search_emails with query "in:inbox" (extract From: addresses)
```

Filter out automated/noreply/bulk patterns (same defaults as email.ts):
- noreply@, no-reply@, notifications@, mailer-daemon@, etc.

Extract display names from From: headers.

### 3. Merge and Deduplicate
- Airtable contacts are source of truth
- Gmail contacts supplement with additional human contacts not yet in CRM
- Flag Gmail-only contacts as `isVip: false`, `relationship: "unknown"` for Joel to classify

### 4. VIP Classification
Set `isVip: true` for any contact where:
- Airtable stage = active client
- Airtable stage = active prospect or active pipeline
- NOT closed-lost, NOT archived, NOT community-only

### 5. Write Output
Write to `/workspace/project/data/email-contacts.json`:
```json
{
  "updatedAt": "2026-03-03T00:00:00.000Z",
  "contacts": [
    {
      "email": "person@company.com",
      "name": "Person Name",
      "company": "Company",
      "isVip": true,
      "relationship": "client",
      "airtableId": "recXXXXXX",
      "notes": "Active onboarding"
    }
  ]
}
```

### 6. Report
Output count of: total contacts, VIP count, new contacts found in Gmail not in CRM.

## Notes
- The contacts file path is relative to the NanoClaw project root
- The email channel reloads this file every 5 minutes (hot-reload, no restart needed)
- Joel may manually add contacts between harvests
