# Automatic Railway Deployment Guide

Everything is now fully automated! When you deploy to Railway, the system will:

✅ **Auto-run database migrations**
✅ **Start cron jobs for follow-ups**
✅ **Sync Notion every 15 minutes**
✅ **Enable adaptive learning**
✅ **Configure all services**

## Required Environment Variables

Set these in your Railway project settings:

### Database & Redis
```bash
DATABASE_URL=postgresql://...    # Automatically set by Railway Postgres
REDIS_URL=redis://...            # Automatically set by Railway Redis
```

### OpenAI (GPT-5)
```bash
OPENAI_API_KEY=sk-proj-...       # Your OpenAI API key
OPENAI_MODEL=gpt-5               # Optional: defaults to gpt-5
```

### Anthropic (Claude - Fallback)
```bash
ANTHROPIC_API_KEY=sk-ant-...     # Your Anthropic API key
CLAUDE_MODEL=claude-3-7-sonnet-20250219  # Optional
```

### SendGrid (Email)
```bash
SENDGRID_API_KEY=SG....          # Your SendGrid API key
SENDGRID_FROM_EMAIL=samuel@matcher.com
SENDGRID_FROM_NAME=MATCHER Legal Department
```

### Notion (Case Management)
```bash
NOTION_API_KEY=secret_...        # Your Notion integration token
NOTION_CASES_DATABASE_ID=...     # Your cases database ID
```

### General Config
```bash
NODE_ENV=production
PORT=3000                        # Railway sets this automatically
DEFAULT_TEST_EMAIL=shadewofficial@gmail.com
REQUESTER_NAME=Samuel Hylton
REQUESTER_EMAIL=shadewofficial@gmail.com
```

## What Happens on Deployment

### 1. Server Starts (`server.js`)
```
🚀 Initializing database...
   ✓ Database initialized successfully

📦 Running database migrations...
   Running 001_initial_schema.sql...
   ✓ 001_initial_schema.sql applied successfully
   Running 002_state_deadlines.sql...
   ✓ 002_state_deadlines.sql applied successfully
   Running 003_response_tracking.sql...
   ✓ 003_response_tracking.sql applied successfully
   Running 004_activity_log.sql...
   ✓ 004_activity_log.sql applied successfully
   Running 005_adaptive_learning_tables.sql...
   ✓ 005_adaptive_learning_tables.sql applied successfully
   ✓ Applied 5 migration(s)

🤖 Starting automated services...
   ✓ Automated follow-ups enabled
   ✓ Notion sync every 15 minutes
   ✓ Adaptive learning system active

🌐 Autobot MVP Server Running
   Port: 3000
   Environment: production
   Database: Connected
   Redis: Connected

   Health check: https://your-app.railway.app/health
   API: https://your-app.railway.app/api
   Webhooks: https://your-app.railway.app/webhooks/inbound

   ✓ Ready to receive requests!
```

### 2. Automatic Migration System

**First deployment:**
- Creates `schema_migrations` table
- Runs all `.sql` files in `migrations/` folder
- Tracks which migrations have been applied

**Future deployments:**
- Only runs NEW migrations
- Skips already-applied migrations
- Zero downtime updates

### 3. Cron Jobs Start Automatically

**Every 5 minutes:**
- Check for cases needing follow-up emails
- Send follow-ups if deadline approaching

**Every 15 minutes:**
- Sync new cases from Notion
- Update Notion with latest status

**Every hour:**
- Update learning insights
- Analyze strategy performance

### 4. Adaptive Learning Activates

The system immediately starts:
- Generating strategic variations for new requests
- Recording outcomes from agency responses
- Learning which strategies work best
- Optimizing future requests based on data

## Verification Checklist

After deployment, verify everything is working:

### 1. Check Health Endpoint
```bash
curl https://your-app.railway.app/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "2025-10-21T...",
  "database": {
    "connected": true,
    "latency_ms": 15
  },
  "environment": "production"
}
```

### 2. Check Migrations Applied
View Railway logs for:
```
✓ Applied 5 migration(s)
✓ Database migrations applied
```

### 3. Test Notion Sync
```bash
curl -X POST https://your-app.railway.app/api/sync/notion
```

Should sync cases from Notion.

### 4. View Learning Insights
```bash
curl https://your-app.railway.app/api/insights
```

Will be empty initially, but should return without errors.

### 5. Test Portal Automation
Visit: `https://your-app.railway.app/`
- Use the portal testing UI
- Enter a portal URL
- Verify it fills the form

## SendGrid Setup (Domain Authentication)

To send emails, you need to authenticate your domain:

1. Go to SendGrid → Settings → Sender Authentication
2. Click "Authenticate Your Domain"
3. Choose your DNS provider
4. Add the DNS records they provide:
   - CNAME for `em1234.yourdomain.com`
   - CNAME for `s1._domainkey.yourdomain.com`
   - CNAME for `s2._domainkey.yourdomain.com`
5. Wait for DNS propagation (10-30 minutes)
6. Verify in SendGrid

Once verified, update Railway environment:
```bash
SENDGRID_FROM_EMAIL=your-email@yourdomain.com
```

## Monitoring

### View Logs
Railway → Your Project → Deployments → Latest → Logs

Look for:
- `✓ Database migrations applied`
- `✓ Automated follow-ups enabled`
- `✓ Adaptive learning system active`
- No errors in startup

### Strategy Performance Dashboard
```bash
curl https://your-app.railway.app/api/strategy-performance
```

Shows:
- Total cases processed
- Approval rate
- Best performing strategies

### Agency-Specific Insights
```bash
curl https://your-app.railway.app/api/insights/Oakland%20Police%20Department?state=CA
```

Shows learned strategies for specific agency.

## Automatic Features

### ✅ Auto-Generate FOIA Requests
When a Notion case is synced:
1. System fetches case details
2. GPT-5 generates request with adaptive strategy
3. Stores strategy for learning
4. Sends email immediately (no delays)

### ✅ Auto-Analyze Responses
When email received via webhook:
1. GPT-5-mini analyzes intent
2. Extracts deadlines, fees, sentiment
3. Records outcome for learning
4. Updates Notion automatically

### ✅ Auto-Follow-Up
Based on state deadlines:
1. Monitors response times
2. Sends polite follow-up after 10 days
3. Sends firm follow-up after 20 days
4. Escalates if needed

### ✅ Auto-Learn and Optimize
Continuously:
1. Tracks which strategies get approvals
2. Learns agency preferences
3. Uses best strategies automatically
4. Explores new variations (20% of time)

## Troubleshooting

### Migrations Not Running
Check Railway logs for:
- `Migration error:` messages
- Database connection issues

Fix: Ensure DATABASE_URL is set and Postgres service is linked.

### Cron Jobs Not Working
Check logs for:
- `Starting automated services...`
- Cron job execution messages

Fix: Ensure Redis is connected (REDIS_URL set).

### SendGrid Errors
Check for:
- `401 Unauthorized` - Invalid API key
- `403 Forbidden` - Domain not verified
- `Maximum credits exceeded` - Need to upgrade plan

Fix: Verify SENDGRID_API_KEY and domain authentication.

### Adaptive Learning Not Working
Check logs for:
- `Using strategy:` messages in generation
- `Recorded learning outcome:` messages

Query database:
```sql
SELECT COUNT(*) FROM foia_strategy_outcomes;
```

Should increase as responses are received.

## Next Steps

1. **Wait for DNS propagation** (if setting up SendGrid domain)
2. **Add cases to Notion** with "Ready to Send" status
3. **Watch the magic happen!** 🚀

The system will:
- Auto-sync cases every 15 minutes
- Generate optimized requests
- Send emails
- Analyze responses
- Learn and improve continuously

## Support

If you encounter issues:
1. Check Railway deployment logs
2. Verify all environment variables are set
3. Test health endpoint
4. Review migration status in logs

All systems are fully automated - just deploy and it works! 🤖
