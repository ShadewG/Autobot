# Autobot MVP - Quick Start Guide

Get your automated FOIA system up and running in 30 minutes.

## Step 1: Push to GitHub (2 minutes)

The code is ready! Just push it to your GitHub repo:

```bash
cd "/Users/samuelhylton/Documents/gits/Autobot MVP"
git init
git add .
git commit -m "Initial Autobot MVP setup"
git remote add origin https://github.com/ShadewG/Autobot.git
git push -u origin main
```

## Step 2: Railway Setup (5 minutes)

### Create Project
1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose `ShadewG/Autobot`
5. Railway will start deploying

### Add Database Services
While it's deploying:
1. Click "+ New" in your project
2. Add "PostgreSQL" (Railway plugin)
3. Click "+ New" again
4. Add "Redis" (Railway plugin)

### Get Your App URL
1. Click on your main service
2. Go to "Settings" tab
3. Click "Generate Domain"
4. Copy the URL (e.g., `https://autobot-production.up.railway.app`)

## Step 3: SendGrid Setup (10 minutes)

### Create Account & Get API Key
1. Go to https://sendgrid.com/pricing (free tier is fine)
2. Sign up for free account
3. Go to Settings → API Keys
4. Click "Create API Key"
5. Name: "Autobot"
6. Select "Full Access"
7. Click "Create & View"
8. **COPY THE KEY** (you won't see it again!)

### Verify Sender
1. Go to Settings → Sender Authentication
2. Click "Verify a Single Sender"
3. Fill in your email and details
4. Check your email and click verification link

### Configure Inbound Parse
1. Go to Settings → Inbound Parse
2. Click "Add Host & URL"
3. **Host**: `replies` (or any subdomain you want)
4. **Domain**: Your domain (or use SendGrid's test domain)
5. **URL**: `https://your-railway-app.up.railway.app/webhooks/inbound`
6. Check "POST the raw, full MIME message"
7. Click "Save"

**Note**: If you don't have a custom domain, SendGrid provides a test domain for inbound parsing.

## Step 4: Notion Setup (8 minutes)

### Create Integration
1. Go to https://www.notion.so/my-integrations
2. Click "+ New integration"
3. **Name**: "Autobot"
4. **Associated workspace**: Your workspace
5. **Capabilities**: Read content, Update content, Insert content
6. Click "Submit"
7. **COPY THE INTERNAL INTEGRATION TOKEN**

### Create Cases Database
1. In Notion, create a new database (full page)
2. Name it "FOIA Cases"
3. Add these properties (click "+Add a property"):

| Property Name | Type | Options |
|--------------|------|---------|
| Case Name | Title | (default) |
| Status | Select | Ready to Send, Sent, Awaiting Response, Responded, Completed |
| Agency Email | Email | - |
| Agency Name | Text | - |
| Subject Name | Text | - |
| State | Select | CA, NY, TX, FL, IL, PA, OH, GA, NC, MI |
| Incident Date | Date | - |
| Incident Location | Text | - |
| Requested Records | Multi-select | Body cam, Police report, 911 call, Dash cam |
| Additional Details | Text | - |
| Send Date | Date | - |
| Last Response | Date | - |
| Days Overdue | Number | - |
| AI Summary | Text | - |

### Share Database with Integration
1. Open your database
2. Click "..." (top right)
3. Select "Add connections"
4. Choose "Autobot" (your integration)
5. **COPY THE DATABASE ID** from the URL:
   - URL format: `notion.so/xxxxx?v=yyyyy`
   - Database ID is the `xxxxx` part (32 characters)

## Step 5: OpenAI Setup (2 minutes)

1. Go to https://platform.openai.com/api-keys
2. Click "+ Create new secret key"
3. Name: "Autobot"
4. Click "Create secret key"
5. **COPY THE KEY**

**Optional**: Get Anthropic API key for Claude fallback at https://console.anthropic.com/

## Step 6: Add Environment Variables to Railway (5 minutes)

1. Go to your Railway project
2. Click on your main service (Autobot)
3. Go to "Variables" tab
4. Click "Raw Editor"
5. Paste this, replacing placeholders with your actual keys:

```bash
SENDGRID_API_KEY=SG.your_actual_key_here
SENDGRID_FROM_EMAIL=your_verified_email@domain.com
SENDGRID_FROM_NAME=FOIA Request Team

NOTION_API_KEY=secret_your_actual_token_here
NOTION_CASES_DATABASE_ID=your_32_character_database_id

OPENAI_API_KEY=sk-proj-your_actual_key_here
ANTHROPIC_API_KEY=sk-ant-your_actual_key_here

NODE_ENV=production
ENABLE_AUTO_REPLY=true
ENABLE_AUTO_FOLLOWUP=true
AUTO_REPLY_CONFIDENCE_THRESHOLD=0.8
MAX_FOLLOWUPS=2
FOLLOWUP_DELAY_DAYS=7
BUSINESS_HOURS_START=9
BUSINESS_HOURS_END=17
```

6. Click "Update Variables"
7. Railway will automatically redeploy

## Step 7: Test! (5 minutes)

### Check Health
Visit: `https://your-railway-app.up.railway.app/health`

You should see:
```json
{
  "status": "ok",
  "database": { "healthy": true },
  "environment": "production"
}
```

### Add Test Case to Notion
1. Go to your "FOIA Cases" database in Notion
2. Click "+ New"
3. Fill in:
   - **Case Name**: Test Case - John Doe
   - **Status**: Ready to Send
   - **Agency Email**: your.test.email@gmail.com (use your own email for testing)
   - **Agency Name**: Test Police Department
   - **Subject Name**: John Doe
   - **State**: CA
   - **Incident Date**: Any date
   - **Incident Location**: 123 Main St
   - **Requested Records**: Police report
   - **Additional Details**: This is a test case

### Trigger Sync
In your terminal or Railway logs, you should see within 15 minutes:
```
Running Notion sync...
Synced 1 new cases from Notion
```

Or manually trigger:
```bash
curl -X POST https://your-railway-app.up.railway.app/api/sync/notion
```

### Watch It Work!
1. Check Railway logs - you'll see:
   - Case imported
   - FOIA request generated
   - Email queued
   - Email sent (after random delay)

2. Check your test email inbox for the FOIA request

3. Reply to that email - the system will:
   - Receive via webhook
   - Analyze the response
   - Update Notion
   - Possibly auto-reply

## Step 8: Monitor (Ongoing)

### Railway Dashboard
- **Logs**: View all activity in real-time
- **Metrics**: Check memory/CPU usage
- **Deployments**: See deployment history

### Notion
Your cases will auto-update with:
- Status changes (Sent → Awaiting Response → Responded)
- Send dates
- Last response dates
- Days overdue
- AI summaries of responses

### API Endpoints
- **Stats**: `GET /api/stats`
- **All cases**: `GET /api/cases`
- **Recent activity**: `GET /api/activity`
- **Pending auto-replies**: `GET /api/auto-replies/pending`

## Common Issues

### "Database not connected"
- Check that PostgreSQL plugin is added in Railway
- Verify DATABASE_URL appears in Variables tab

### "Notion sync failed"
- Ensure database is shared with integration
- Double-check database ID is correct
- Verify property names match exactly (case-sensitive!)

### "Email not sending"
- Confirm SendGrid API key is valid
- Check sender email is verified
- Look for errors in Railway logs

### "No inbound emails processing"
- Test webhook: `curl -X POST https://your-app.railway.app/webhooks/test`
- Verify SendGrid inbound parse URL is correct
- Check Railway logs when you send a test reply

## Next Steps

1. **Add Real Cases**: Import cases from your foia-researcher tool
2. **Customize Templates**: Edit AI prompts in `services/ai-service.js`
3. **Add Slack Alerts**: Get SLACK_WEBHOOK_URL and add to env vars
4. **Monitor Costs**: Check OpenAI usage dashboard
5. **Scale Up**: Upgrade Railway plan if needed

## Need Help?

Check Railway logs:
```
Railway Dashboard → Your Service → Deployments → View Logs
```

All errors and activity are logged there!

---

**You're all set! 🤖 The system will now:**
- ✅ Auto-sync cases from Notion every 15 minutes
- ✅ Generate professional FOIA requests with AI
- ✅ Send emails with natural delays
- ✅ Analyze responses and auto-reply when appropriate
- ✅ Follow up on overdue requests automatically
- ✅ Keep Notion updated in real-time

Happy automating!
