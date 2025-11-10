# Autobot MVP

Automated FOIA Request System with AI-powered generation, email tracking, and intelligent follow-ups.

## Features

- 🤖 **AI-Powered Request Generation** - Automatically generate professional FOIA requests using OpenAI GPT-5
- 📧 **Email Automation** - Send requests via SendGrid with natural delays to appear human
- 🔄 **Auto Follow-ups** - Intelligently follow up on overdue requests based on state deadlines
- 📊 **Notion Integration** - Sync cases from Notion database and update status automatically
- 🧠 **Response Analysis** - AI analyzes agency responses and can auto-reply to simple questions
- ⏰ **Smart Scheduling** - Queue emails during business hours with randomized delays
- 📈 **Activity Tracking** - Monitor all emails, follow-ups, and responses in one place

## Architecture

```
Notion Database
    ↓
Case Sync (every 15 min)
    ↓
AI Request Generation
    ↓
Email Queue (with delays)
    ↓
SendGrid → Agency
    ↓
Inbound Webhook ← Agency Response
    ↓
AI Analysis
    ↓
Auto-Reply or Alert
    ↓
Follow-up Scheduler
```

## Setup Instructions

### 1. Railway Deployment

#### Create Railway Project
1. Go to [railway.app](https://railway.app)
2. Create a new project
3. Connect this GitHub repository
4. Add the following services:
   - **PostgreSQL** (Railway plugin)
   - **Redis** (Railway plugin)

#### Configure Environment Variables
In Railway dashboard, add these environment variables:

```bash
# Database (automatically provided by Railway)
DATABASE_URL=<auto-filled>
REDIS_URL=<auto-filled>

# SendGrid
SENDGRID_API_KEY=<your_api_key>
SENDGRID_FROM_EMAIL=requests@yourdomain.com
SENDGRID_FROM_NAME=FOIA Request Team

# Notion
NOTION_API_KEY=<your_integration_key>
NOTION_CASES_DATABASE_ID=<your_database_id>

# OpenAI
OPENAI_API_KEY=<your_api_key>
ANTHROPIC_API_KEY=<your_api_key>  # Optional fallback

# App Config
NODE_ENV=production
PORT=3000

# Feature Flags (optional)
ENABLE_AUTO_REPLY=true
ENABLE_AUTO_FOLLOWUP=true
AUTO_REPLY_CONFIDENCE_THRESHOLD=0.8
MAX_FOLLOWUPS=2
FOLLOWUP_DELAY_DAYS=7
```

### 2. SendGrid Setup

1. **Create Account** at [sendgrid.com](https://sendgrid.com)
2. **Get API Key**:
   - Settings → API Keys → Create API Key
   - Select "Full Access"
   - Copy the key and add to Railway env vars

3. **Verify Sender Email**:
   - Settings → Sender Authentication
   - Verify single sender email OR set up domain authentication

4. **Configure Inbound Parse**:
   - Settings → Inbound Parse → Add Host & URL
   - Host: Your domain (e.g., `replies.yourdomain.com`)
   - URL: `https://your-railway-app.up.railway.app/webhooks/inbound`
   - Check "POST the raw, full MIME message"

5. **Event Webhook** (Optional):
   - Settings → Mail Settings → Event Webhook
   - URL: `https://your-railway-app.up.railway.app/webhooks/events`
   - Select events: Delivered, Bounced, Dropped, Opened

### 3. Notion Setup

1. **Create Integration**:
   - Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
   - Click "New integration"
   - Give it a name (e.g., "Autobot")
   - Copy the Internal Integration Token

2. **Create Cases Database**:
   Create a Notion database with these properties:
   - **Case Name** (Title)
   - **Status** (Select): Ready to Send, Sent, Awaiting Response, Responded, Completed
   - **Agency Email** (Email)
   - **Agency Name** (Text)
   - **Subject Name** (Text)
   - **State** (Select): CA, NY, TX, FL, etc.
   - **Incident Date** (Date)
   - **Incident Location** (Text)
   - **Requested Records** (Multi-select): Body cam, Police report, 911 call, etc.
   - **Additional Details** (Text)
   - **Send Date** (Date)
   - **Last Response** (Date)
   - **Days Overdue** (Number)
   - **AI Summary** (Text)

3. **Share Database with Integration**:
   - Open your database in Notion
   - Click "..." → "Add connections"
   - Select your integration
   - Copy the database ID from URL (the part after the slash and before the "?")

### 4. OpenAI Setup

1. Go to [platform.openai.com](https://platform.openai.com)
2. Create API key in "API Keys" section
3. Add billing method
4. Copy key to Railway env vars

### 5. Deploy

1. Push code to GitHub:
```bash
git add .
git commit -m "Initial Autobot MVP setup"
git push origin main
```

2. Railway will automatically deploy

3. Check deployment logs for any errors

4. Visit your app URL to confirm it's running

## API Endpoints

### Health Check
```
GET /health
```
Returns server status and database health.

### Sync Cases from Notion
```
POST /api/sync/notion
Body: { "status": "Ready to Send" }
```

### Process All Ready Cases
```
POST /api/process/all
```
Generates and queues all cases with status "ready_to_send"

### Process Single Case
```
POST /api/process/:caseId
```

### Get All Cases
```
GET /api/cases?status=sent
```

### Get Case Details
```
GET /api/cases/:caseId
```

### Get Email Thread
```
GET /api/cases/:caseId/thread
```

### Get Pending Auto-Replies
```
GET /api/auto-replies/pending
```

### Approve Auto-Reply
```
POST /api/auto-replies/:id/approve
```

### Get Statistics
```
GET /api/stats
```

### Get Recent Activity
```
GET /api/activity?limit=50
```

## How It Works

### 1. Case Import
- Every 15 minutes, system checks Notion for cases with status "Ready to Send"
- New cases are imported to database
- Deadline calculated based on state law (from `state_deadlines` table)

### 2. Request Generation
- AI generates professional FOIA request from case details
- Uses OpenAI GPT-5 (fallback to Claude if needed)
- Stored as draft in database

### 3. Email Sending
- Request queued with random 2-10 minute delay
- Only sends during business hours (9 AM - 5 PM)
- Sent via SendGrid API
- Thread tracking enabled via email headers
- Updates Notion status to "Sent"
- Schedules follow-up based on deadline

### 4. Response Processing
- SendGrid webhook receives inbound emails
- System matches to case by thread ID or agency email
- AI analyzes response:
  - Intent (acknowledgment, question, delivery, denial, etc.)
  - Sentiment (positive, neutral, negative)
  - Extracted info (deadlines, fees, action items)
- Updates Notion with AI summary

### 5. Auto-Reply
- If AI confidence > 80% and simple question:
  - Generates appropriate reply
  - Queues for sending
- If complex or uncertain:
  - Stores in approval queue
  - You can review and approve via API

### 6. Follow-ups
- Daily cron job (9 AM) checks for overdue requests
- Generates polite follow-up referencing state law
- Max 2 follow-ups per case
- After max reached, alerts you via activity log

## Database Schema

See `database/schema.sql` for complete schema.

Key tables:
- `cases` - Main case records
- `email_threads` - Conversation tracking
- `messages` - Individual emails
- `response_analysis` - AI analysis results
- `follow_up_schedule` - Automated follow-up queue
- `auto_reply_queue` - Pending auto-replies

## Development

### Local Setup
```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
nano .env

# Run locally
npm run dev
```

### Database Migration
The schema auto-initializes on first run. To manually run:
```bash
npm run migrate
```

## Monitoring

### View Logs
Railway dashboard → Deployments → Select deployment → View logs

### Activity Log
All important events are logged to `activity_log` table:
```sql
SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50;
```

### Check Queue Status
Jobs are processed by BullMQ workers. Monitor via Redis:
```bash
# In Railway console
redis-cli
> KEYS bull:*
```

## Troubleshooting

### Emails Not Sending
1. Check SendGrid API key is valid
2. Verify sender email is authenticated
3. Check Railway logs for errors
4. Ensure REDIS_URL is set (queue needs Redis)

### Inbound Emails Not Processing
1. Verify SendGrid inbound parse URL is correct
2. Check webhook receives POST requests (test endpoint: `/webhooks/test`)
3. Ensure agency email matches database records

### Notion Sync Not Working
1. Verify integration has access to database
2. Check database ID is correct
3. Ensure property names match exactly

### Follow-ups Not Sending
1. Check cron jobs are running (view startup logs)
2. Verify follow-up schedules exist: `SELECT * FROM follow_up_schedule`
3. Check `ENABLE_AUTO_FOLLOWUP=true` in env

## OpenAI AgentKit Portal Automation (Experimental)

1. Create a Browser-enabled automation inside the [OpenAI](https://platform.openai.com/) dashboard (AgentKit) so the model can open Chrome instances on your behalf.
2. Copy the automation ID and add it as `OPENAI_PORTAL_AUTOMATION_ID` alongside your `OPENAI_API_KEY`.
3. Run `node test-portal-agentkit.js <portal-url> [caseId]` to compare the AgentKit workflow with the built-in Playwright portal agent.
4. Use AgentKit for especially tricky portals (GovQA, Tyler, NIC, etc.) where DOM selectors are brittle—the model can reason over rendered UI elements and images automatically.

## Cost Estimate

- **Railway**: $5-10/month (Hobby plan)
- **SendGrid**: Free (100 emails/day) or $20/month (50k emails)
- **OpenAI**: ~$0.10-0.50 per case
  - GPT-5 for generation: ~$0.30
  - GPT-5-mini for analysis: ~$0.01
- **Total**: ~$10-35/month + usage-based AI costs

## Security

- All API keys stored as env vars (never committed)
- Database uses SSL in production
- SendGrid webhook signature verification enabled
- No sensitive data logged

## License

MIT

## Support

For issues or questions, check Railway logs or contact maintainer.
