# Test Run: Initial Request Flow

This document describes how to test the first part of the FOIA automation pipeline - sending initial requests and monitoring for responses.

## Test Scope

### What We're Testing
1. Import cases from Notion with "Ready To Send" status
2. Generate FOIA request using LangGraph (AI drafts the request)
3. Review and approve the generated proposal
4. Send email via SendGrid
5. Monitor for inbound responses

### What Happens to Responses
When responses arrive via SendGrid webhook:
1. **Stored**: Message saved to `messages` table
2. **Analyzed**: AI classifies intent, sentiment, extracts fees/deadlines
3. **Notified**: Discord notification sent
4. **Notion Updated**: Summary added to Notion page
5. **Paused for Review**: If complex (denial, fee quote, etc.), creates a proposal requiring human approval

The system runs in **SUPERVISED** mode by default, so responses that need action will pause for human review rather than auto-processing.

## Prerequisites

1. **Environment Variables** (in `.env`):
   ```
   # Required
   DATABASE_URL=postgres://...
   REDIS_URL=redis://...
   SENDGRID_API_KEY=SG.xxx
   SENDGRID_FROM_EMAIL=your-foia@domain.com
   NOTION_API_KEY=secret_xxx
   NOTION_CASES_DATABASE_ID=xxx
   OPENAI_API_KEY=sk-xxx

   # Optional
   LANGGRAPH_DRY_RUN=false  # Set true to skip actual email sending
   USE_RUN_ENGINE=true      # Use new audit trail system
   ```

2. **Services Running**:
   - Express server: `npm run dev`
   - Redis: Required for Bull queues
   - Postgres: Required for database

3. **Notion Setup**:
   - Cases with "Ready To Send" status in Live Status field
   - Each case linked to a Police Department with contact email

## Running the Test

### Option 1: Using the Test Script

```bash
# Sync cases from Notion and test first one
node scripts/test-initial-request-flow.js --sync-notion

# Test specific case by ID
node scripts/test-initial-request-flow.js --case-id=1660

# Import from specific Notion page
node scripts/test-initial-request-flow.js --notion-url="https://notion.so/..."

# Auto-approve proposals (careful in production!)
node scripts/test-initial-request-flow.js --case-id=1660 --auto-approve

# Watch for responses after sending
node scripts/test-initial-request-flow.js --case-id=1660 --auto-approve --watch
```

### Option 2: Manual API Calls

**Step 1: Sync cases from Notion**
```bash
curl -X POST http://localhost:3000/api/sync/notion \
  -H "Content-Type: application/json" \
  -d '{"status": "Ready To Send"}'
```

**Step 2: Trigger initial request generation**
```bash
curl -X POST http://localhost:3000/api/run-engine/cases/1660/run-initial \
  -H "Content-Type: application/json" \
  -d '{"autopilotMode": "SUPERVISED"}'
```

**Step 3: Check run status and proposal**
```bash
# Get run status
curl http://localhost:3000/api/run-engine/runs/123

# List pending proposals
curl http://localhost:3000/api/run-engine/proposals
```

**Step 4: Approve the proposal**
```bash
curl -X POST http://localhost:3000/api/run-engine/proposals/456/decision \
  -H "Content-Type: application/json" \
  -d '{"action": "APPROVE"}'
```

**Step 5: Monitor for responses**
```bash
# Check case thread for messages
curl http://localhost:3000/api/cases/1660/thread
```

## Verifying Success

### Initial Request Sent
- Check `agent_runs` table: status = 'completed'
- Check `messages` table: outbound message with direction = 'outbound'
- Check `cases` table: status = 'sent' or 'awaiting_response'
- Check Notion: Live Status updated to "Sent"

### Response Received
- Check `messages` table: new message with direction = 'inbound'
- Check `response_analysis` table: AI classification stored
- Check Discord: notification received
- Check Notion: AI Summary updated

### Dashboard Views
- `/api/run-engine/runs` - All agent runs
- `/api/run-engine/proposals` - Pending approvals
- `/api/cases/1660` - Full case details with messages

## Limiting Failure Points

For a controlled test:

1. **Start with one case**: Use `--case-id` to test a single known-good case
2. **Review before sending**: Don't use `--auto-approve` initially
3. **Check the draft**: Verify the generated email looks correct
4. **Dry run first**: Set `LANGGRAPH_DRY_RUN=true` to skip actual sending
5. **Monitor responses**: Use `--watch` or check the `/api/cases/:id/thread` endpoint

## Response Processing (Future Feature)

Responses are stored and analyzed but may pause for human approval. To batch-process pending responses later:

1. List pending proposals: `GET /api/run-engine/proposals?status=PENDING_APPROVAL`
2. Approve individually: `POST /api/run-engine/proposals/:id/decision`
3. Or implement a batch approval endpoint (future feature)

## Troubleshooting

### No proposals generated
- Check agent_runs table for errors
- Check server logs for LangGraph errors
- Verify case has agency_email set

### Email not sent
- Check `LANGGRAPH_DRY_RUN` is not true
- Check SendGrid API key is valid
- Check Bull queue for failed jobs: `GET /api/queue/pending`

### Responses not appearing
- Verify SendGrid inbound parse is configured
- Check `/webhooks/inbound` is receiving POSTs
- Check server logs for webhook processing
