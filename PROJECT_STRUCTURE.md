# Autobot MVP - Project Structure

```
Autobot MVP/
│
├── server.js                      # Main Express server & entry point
├── package.json                   # Dependencies and scripts
├── railway.json                   # Railway deployment config
├── .env.example                   # Environment variable template
├── .gitignore                     # Git ignore rules
│
├── README.md                      # Full documentation
├── QUICKSTART.md                  # Step-by-step setup guide
├── PROJECT_STRUCTURE.md           # This file
│
├── database/
│   ├── schema.sql                 # Complete database schema
│   └── migrate.js                 # Migration script
│
├── services/                      # Core business logic
│   ├── database.js                # PostgreSQL client & queries
│   ├── notion-service.js          # Notion integration & sync
│   ├── sendgrid-service.js        # Email sending & receiving
│   ├── ai-service.js              # OpenAI/Claude for generation & analysis
│   ├── follow-up-service.js       # Automated follow-up scheduling
│   └── cron-service.js            # Scheduled tasks orchestration
│
├── queues/
│   └── email-queue.js             # BullMQ job queues & workers
│
├── routes/
│   ├── webhooks.js                # SendGrid inbound webhook handlers
│   └── api.js                     # REST API endpoints
│
└── test-setup.js                  # Environment validation script
```

## Service Architecture

### Core Services

**database.js**
- PostgreSQL connection pool
- Query abstraction layer
- CRUD operations for all tables
- Activity logging
- Health checks

**notion-service.js**
- Fetch cases from Notion database
- Parse Notion properties to case format
- Update Notion pages with status changes
- Two-way sync (Notion ↔ Database)
- Deadline calculation

**sendgrid-service.js**
- Send FOIA requests
- Send follow-ups
- Send auto-replies
- Process inbound emails via webhook
- Thread tracking (Message-ID, In-Reply-To, References)
- HTML email formatting

**ai-service.js**
- Generate FOIA requests (GPT-4o)
- Analyze agency responses (GPT-4o-mini)
- Generate auto-replies
- Generate follow-up emails
- Claude fallback support
- Cost tracking

**follow-up-service.js**
- Cron job for daily follow-up checks
- State-specific deadline tracking
- Max follow-up enforcement
- Overdue case detection
- Random delay generation

**cron-service.js**
- Notion sync (every 15 minutes)
- Follow-up checks (daily at 9 AM)
- Cleanup old logs (daily at midnight)
- Health checks (every 5 minutes)

### Queue System

**email-queue.js** (BullMQ + Redis)
- Email sending queue with delays
- Response analysis queue
- Request generation queue
- Workers for async processing
- Retry logic
- Business hours enforcement

### API Routes

**webhooks.js**
- POST `/webhooks/inbound` - SendGrid inbound email
- POST `/webhooks/events` - SendGrid delivery events
- POST `/webhooks/test` - Webhook testing

**api.js**
- POST `/api/sync/notion` - Manual Notion sync
- POST `/api/process/all` - Process all ready cases
- POST `/api/process/:caseId` - Process single case
- GET `/api/cases` - List cases
- GET `/api/cases/:caseId` - Case details
- GET `/api/cases/:caseId/thread` - Email thread
- GET `/api/auto-replies/pending` - Pending auto-replies
- POST `/api/auto-replies/:id/approve` - Approve auto-reply
- GET `/api/stats` - Dashboard statistics
- GET `/api/activity` - Recent activity log

## Data Flow

### 1. Case Import Flow
```
Notion Database
    ↓ (every 15 min via cron)
notionService.syncCasesFromNotion()
    ↓
database.createCase()
    ↓
generateQueue.add()
    ↓
Worker: aiService.generateFOIARequest()
    ↓
emailQueue.add() (with random delay)
```

### 2. Email Sending Flow
```
emailQueue job
    ↓
Worker: sendgridService.sendFOIARequest()
    ↓
SendGrid API
    ↓
database.createMessage()
    ↓
database.updateCaseStatus('sent')
    ↓
notionService.syncStatusToNotion()
    ↓
database.createFollowUpSchedule()
```

### 3. Response Processing Flow
```
Agency replies
    ↓
SendGrid Inbound Parse
    ↓
POST /webhooks/inbound
    ↓
sendgridService.processInboundEmail()
    ↓
database.createMessage()
    ↓
analysisQueue.add()
    ↓
Worker: aiService.analyzeResponse()
    ↓
database.createResponseAnalysis()
    ↓
notionService.addAISummaryToNotion()
    ↓
(if auto-reply eligible)
    ↓
aiService.generateAutoReply()
    ↓
emailQueue.add() OR auto_reply_queue (for approval)
```

### 4. Follow-up Flow
```
Cron daily at 9 AM
    ↓
followUpService.processFollowUps()
    ↓
database.getDueFollowUps()
    ↓
for each overdue case:
    aiService.generateFollowUp()
    ↓
    emailQueue.add()
    ↓
    database.updateFollowUpSchedule()
```

## Database Tables

See `database/schema.sql` for complete schema.

**Primary Tables:**
- `cases` - Main case records (linked to Notion)
- `email_threads` - Conversation tracking
- `messages` - Individual emails (sent/received)
- `response_analysis` - AI analysis results
- `follow_up_schedule` - Automated follow-ups
- `generated_requests` - AI-generated request texts
- `auto_reply_queue` - Pending auto-replies
- `state_deadlines` - State-specific response times
- `activity_log` - System event logging

## Environment Variables

**Required:**
- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `SENDGRID_API_KEY` - Email sending
- `SENDGRID_FROM_EMAIL` - Sender email
- `NOTION_API_KEY` - Notion integration token
- `NOTION_CASES_DATABASE_ID` - Notion database ID
- `OPENAI_API_KEY` - AI request generation

**Optional:**
- `ANTHROPIC_API_KEY` - Claude fallback
- `SLACK_WEBHOOK_URL` - Slack notifications
- `ENABLE_AUTO_REPLY` - Auto-reply feature flag
- `ENABLE_AUTO_FOLLOWUP` - Auto follow-up flag
- `AUTO_REPLY_CONFIDENCE_THRESHOLD` - Min confidence (0-1)
- `MAX_FOLLOWUPS` - Max follow-ups per case
- `FOLLOWUP_DELAY_DAYS` - Days between follow-ups

## Deployment

**Railway Configuration:**
- `railway.json` defines build and deploy settings
- Nixpacks auto-detects Node.js
- `npm start` runs `server.js`
- Auto-restart on failure (max 10 retries)

**Required Railway Services:**
- Main app service (this repo)
- PostgreSQL plugin
- Redis plugin

**Scaling:**
- Vertical: Increase Railway plan for more resources
- Horizontal: Queue workers can scale independently
- Database: Railway managed PostgreSQL handles connection pooling

## Testing

**Setup Validation:**
```bash
npm run test-setup
```

**Manual Migration:**
```bash
npm run migrate
```

**Local Development:**
```bash
npm run dev
```

**API Testing:**
```bash
# Health check
curl https://your-app.railway.app/health

# Sync Notion
curl -X POST https://your-app.railway.app/api/sync/notion

# Get stats
curl https://your-app.railway.app/api/stats
```

## Monitoring

**Railway Dashboard:**
- Real-time logs
- Memory/CPU metrics
- Deployment history
- Environment variables

**Database Queries:**
```sql
-- Recent activity
SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50;

-- Cases by status
SELECT status, COUNT(*) FROM cases GROUP BY status;

-- Overdue cases
SELECT * FROM cases WHERE days_overdue > 0;

-- Recent messages
SELECT * FROM messages ORDER BY created_at DESC LIMIT 20;

-- Pending auto-replies
SELECT * FROM auto_reply_queue WHERE status = 'pending';
```

## Security Features

- Environment variables for all secrets
- SSL/TLS for database connections
- SendGrid webhook signature verification
- No sensitive data in logs
- Express helmet for HTTP security headers
- CORS configuration
- Input validation via express-validator (routes)

## Performance Optimizations

- Database connection pooling
- Redis caching for queues
- BullMQ for async processing
- Indexed database queries
- Business hours delay batching
- Retry with exponential backoff
- Cleanup old logs automatically

---

For detailed API documentation, see README.md
For setup instructions, see QUICKSTART.md
