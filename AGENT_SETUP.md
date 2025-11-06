# FOIA Case Manager Agent - Setup & Deployment Guide

## Overview

The FOIA Case Manager Agent is an **autonomous AI system** that handles complex FOIA cases using GPT-5 family models with tool calling. It makes strategic decisions about how to respond to agency emails, when to escalate to humans, and how to maximize case success rates.

This system uses a **hybrid approach**:
- **Complex cases** (denials, high fees, hostile responses) → Handled by AI agent
- **Simple cases** (approvals, acknowledgments) → Handled by deterministic flow

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│         FOIA Email Workflow                     │
└─────────────────────────────────────────────────┘

Agency Reply
     ↓
Analysis Worker
     ↓
Check: Is this complex?
     ↓
┌─────────────┬─────────────┐
│  YES        │  NO         │
│  (Complex)  │  (Simple)   │
└──────┬──────┴──────┬──────┘
       │             │
   🤖 AGENT      📋 DETERMINISTIC
       │             │
   Makes AI         Hard-coded
   Decisions        Rules
       │             │
       ↓             ↓
  Takes Action   Takes Action
```

**Complex Cases Include:**
- Denials (any type)
- Fee notices > $100
- Requests for clarification
- Hostile/angry responses
- Cases with 2+ previous failed attempts

---

## File Structure

```
services/
├── foia-case-agent.js          # Main agent with tool calling
├── notification-service.js      # Discord/Notion notifications
├── ai-service.js               # Existing AI functions (used as tools)
└── database.js                 # Database access

queues/
└── email-queue.js              # Updated with hybrid logic (lines 184-228)

migrations/
└── add-agent-tables.sql        # Database tables for agent

Database Tables (New):
├── agent_decisions             # Logs agent reasoning & decisions
├── escalations                 # Cases needing human review
└── cases.agent_handled         # Flag for agent-handled cases
```

---

## Setup Instructions

### Step 1: Run Database Migration

The agent requires two new tables: `agent_decisions` and `escalations`.

```bash
# From project root
node run-migration.js migrations/add-agent-tables.sql
```

**Expected output:**
```
✓ Tables created:
  - agent_decisions
  - escalations

✓ Views created:
  - pending_escalations
  - agent_performance

🎉 Migration complete!
```

**Verify migration:**
```bash
# Check tables exist
psql $DATABASE_URL -c "\dt" | grep -E "agent_decisions|escalations"
```

---

### Step 2: Configure Environment Variables

Add these to your Railway environment (or `.env` for local):

```bash
# ===== AGENT CONFIGURATION =====

# Enable/disable the autonomous agent
ENABLE_AGENT=false           # Set to 'true' to enable agent for complex cases

# Enable notifications for escalations
ENABLE_NOTIFICATIONS=true    # Set to 'true' to enable Discord/Notion alerts

# Discord webhook URL for escalation alerts (optional)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_URL

# OpenAI API key (required for agent)
OPENAI_API_KEY=sk-...        # Already set, but agent uses it extensively
```

**To get a Discord webhook:**
1. Go to your Discord server
2. Server Settings → Integrations → Webhooks
3. Create Webhook → Copy URL
4. Paste into `DISCORD_WEBHOOK_URL`

---

### Step 3: Enable the Agent (Gradual Rollout)

**Option A: Start with Agent DISABLED (Recommended)**

```bash
# Railway environment variables
ENABLE_AGENT=false
ENABLE_NOTIFICATIONS=true
```

This lets you:
- Monitor system with notifications enabled
- See what cases WOULD be handled by agent (check logs)
- Verify everything is working before enabling agent

**Option B: Enable Agent for Testing**

```bash
ENABLE_AGENT=true
ENABLE_NOTIFICATIONS=true
```

The agent will now handle complex cases automatically.

---

## How It Works

### Trigger Flow

```
1. Inbound Email Webhook
   ↓
2. Analysis Worker (queues/email-queue.js:150)
   ↓
3. AI Analysis (intent, sentiment, fees, etc.)
   ↓
4. Check if complex case (lines 189-195)
   ↓
5. IF complex AND agent enabled:
      → foiaCaseAgent.handleCase(caseId, trigger)
   ELSE:
      → Deterministic flow (original logic)
```

### Agent Decision Loop

```javascript
async handleCase(caseId, trigger) {
    // 1. Fetch full case context
    const context = await fetchCaseContext(caseId);

    // 2. Agent analyzes situation
    const response = await openai.chat.completions.create({
        model: 'gpt-5',
        messages: [...systemPrompt, userContext],
        tools: [fetch_context, draft_rebuttal, send_email, escalate, ...]
    });

    // 3. Agent decides which tools to use
    if (response.tool_calls) {
        for (tool of tool_calls) {
            await executeTool(tool.name, tool.args);
        }
    }

    // 4. Repeat until agent says "DONE" (max 5 iterations)
}
```

### Example Agent Decision

**Scenario:** Agency denies request citing "ongoing investigation"

**Agent Reasoning:**
```
OBSERVATION: Agency denied using exemption 7(a) - ongoing investigation

CONTEXT:
- State: California (strong CPRA laws)
- Case is 30 days old
- First denial received
- No specific harm mentioned

DECISION:
1. This exemption requires specific harm demonstration in CA
2. Denial seems over-broad
3. I should research CA law and draft strong rebuttal

TOOLS TO USE:
1. draft_denial_rebuttal (will auto-research CA laws)
2. send_email (with 4-hour delay)
3. schedule_followup (in 10 days)
4. log_decision (for learning)
```

**Agent Executes:**
- Researches CA Govt Code §7923.600
- Drafts rebuttal citing specific requirements
- Schedules email for 4 hours (human-like delay)
- Logs decision with confidence: 0.85

---

## Agent Tools (Available to AI)

The agent can call these tools to take actions:

| Tool | Purpose | Example |
|------|---------|---------|
| `fetch_case_context` | Get full case details, messages, analysis | Always called first |
| `draft_denial_rebuttal` | Research laws + draft strong rebuttal | For denials |
| `draft_clarification` | Respond to info requests | For clarification requests |
| `draft_followup` | Generate follow-up email | For no response |
| `send_email` | Send email with human-like delay (2-10h) | After drafting |
| `schedule_followup` | Schedule future follow-up | After sending |
| `update_case_status` | Change case status | Mark as approved, denied, etc. |
| `escalate_to_human` | Flag for human review | When uncertain or risky |
| `log_decision` | Log reasoning for learning | Always at end |

---

## Monitoring & Debugging

### View Agent Activity in Logs

**Railway logs will show:**
```
🤖 Agent Status:
   Agent enabled: true
   Complex case: true
   Reason: denial

🚀 Delegating to FOIA Agent for complex case handling...

🤖 FOIA Agent handling case 42
   Trigger: inbound_email

🔄 Agent iteration 1/5
   🛠️  Agent calling 1 tool(s)
      → fetch_case_context({"case_id":42})

🔄 Agent iteration 2/5
   🛠️  Agent calling 3 tool(s)
      → draft_denial_rebuttal({"case_id":42,"message_id":89})
      → send_email({"case_id":42,...})
      → log_decision({"reasoning":"Denial seems weak..."})

✅ Agent handling complete
   Iterations: 2
```

### View Agent Decisions in Database

```sql
-- See all agent decisions
SELECT
    ad.id,
    ad.case_id,
    c.case_name,
    ad.reasoning,
    ad.action_taken,
    ad.confidence,
    ad.created_at
FROM agent_decisions ad
JOIN cases c ON ad.case_id = c.id
ORDER BY ad.created_at DESC
LIMIT 10;
```

### View Pending Escalations

```sql
-- Use the pre-made view
SELECT * FROM pending_escalations;
```

Or via API:
```bash
curl https://your-app.up.railway.app/api/escalations
```

### Agent Performance Metrics

```sql
-- Use the pre-made view
SELECT * FROM agent_performance
WHERE decision_date >= CURRENT_DATE - INTERVAL '7 days';
```

Shows:
- Actions taken per day
- Average confidence
- Success vs failure outcomes

---

## Escalation Notifications

When the agent calls `escalate_to_human()`, you'll receive:

**Discord Notification:**
```
🚨 FOIA Case Escalation
Case #42 needs human review

Case Name: John Doe Police Records
Agency: LAPD
Urgency: HIGH
Reason: Fee of $5,000 seems unreasonable, legal review needed

💡 Suggested Action: Negotiate fee down or challenge as excessive

🔗 View Case: https://your-app.railway.app/api/cases/42
```

**Notion Update:**
- Status changes to "Needs Review"
- Escalation reason added to page

---

## Testing the Agent

### Test with a Mock Denial

```bash
# 1. Create a test case in Notion with status "Ready to Send"
# 2. Let system send initial request
# 3. Reply from agency email with denial:

Subject: Re: Public Records Request
Body: "Your request is denied due to ongoing investigation."

# 4. Watch logs for agent handling
```

### Verify Agent Ran

```sql
-- Check if agent handled the case
SELECT
    c.id,
    c.case_name,
    c.agent_handled,
    c.status,
    ad.reasoning,
    ad.action_taken
FROM cases c
LEFT JOIN agent_decisions ad ON c.id = ad.case_id
WHERE c.agent_handled = true
ORDER BY c.id DESC;
```

### Simulate Escalation

You can manually trigger escalation to test notifications:

```javascript
// In Railway console or test script
const foiaCaseAgent = require('./services/foia-case-agent');

await foiaCaseAgent.escalateToHuman({
    case_id: 1,
    reason: 'Test escalation',
    urgency: 'medium',
    suggested_action: 'Review and respond manually'
});
```

Check Discord for notification.

---

## Cost Analysis

### Agent vs Deterministic Flow

| Metric | Deterministic | Agent (Hybrid) |
|--------|---------------|----------------|
| **Cost per simple case** | $0.10 - 0.20 | $0.10 - 0.20 (same) |
| **Cost per complex case** | $0.20 - 0.40 | $0.50 - 1.50 |
| **Average cost (70% simple)** | ~$0.15 | ~$0.30 |
| **Success rate estimate** | 60-70% | 75-85% |
| **Human review needed** | 20% of cases | 5-10% of cases |

**Conclusion:** Agent costs 2x more but reduces human work by 50-60% and increases success by 10-15%.

### Monthly Cost Projection

**Assumptions:**
- 100 cases/month
- 30% complex (agent), 70% simple (deterministic)

**Costs:**
- 70 simple cases × $0.15 = $10.50
- 30 complex cases × $1.00 = $30.00
- **Total: ~$40.50/month**

Compare to:
- Human handling 100 cases manually: ~40 hours at $50/hr = $2,000

**ROI:** Agent saves $1,960/month while handling more volume.

---

## Troubleshooting

### Agent not running

**Check:**
```bash
# 1. Is ENABLE_AGENT=true?
echo $ENABLE_AGENT

# 2. Are cases actually complex?
# Check logs for "Complex case: false"

# 3. Is OpenAI API key valid?
echo $OPENAI_API_KEY
```

### Agent failing/timing out

**Check logs for:**
```
❌ Agent failed, falling back to deterministic flow: <error>
```

**Common causes:**
- OpenAI rate limit hit
- Tool execution error
- Database timeout

**Solution:**
- Check OpenAI dashboard for limits
- Increase worker lock duration if timing out
- Check database connection

### No escalation notifications

**Check:**
```bash
# 1. Are notifications enabled?
echo $ENABLE_NOTIFICATIONS

# 2. Is Discord webhook set?
echo $DISCORD_WEBHOOK_URL

# 3. Check logs for:
ℹ️  Notifications disabled, skipping escalation alert
```

---

## Rollout Checklist

- [ ] Run database migration (`node run-migration.js migrations/add-agent-tables.sql`)
- [ ] Set `ENABLE_AGENT=false` initially
- [ ] Set `ENABLE_NOTIFICATIONS=true`
- [ ] Add `DISCORD_WEBHOOK_URL` (optional but recommended)
- [ ] Deploy to Railway
- [ ] Monitor logs for "Complex case: true" to see what WOULD be handled by agent
- [ ] After 24-48 hours of monitoring, set `ENABLE_AGENT=true`
- [ ] Watch for escalations in Discord
- [ ] Review `agent_decisions` table weekly to see agent performance
- [ ] Adjust system prompt if needed based on outcomes

---

## Advanced: Customizing Agent Behavior

### Modify System Prompt

Edit `services/foia-case-agent.js` lines 22-80 to change agent instructions.

**Examples:**

**Be more aggressive:**
```javascript
For denials:
- Always challenge unless clearly valid
- Use stronger legal language
- Request specific harm demonstration
- Cite case precedents
```

**Be more conservative:**
```javascript
For denials:
- Escalate to human if denial cites valid exemption
- Only challenge if clearly over-broad
- Prefer polite negotiation over aggressive rebuttals
```

### Add New Tools

```javascript
// In foia-case-agent.js, add to getToolDefinitions():
{
    type: 'function',
    function: {
        name: 'search_case_law',
        description: 'Search for relevant FOIA case law precedents',
        parameters: { ... }
    }
}

// Then implement the tool:
async searchCaseLaw({ state, topic }) {
    // Your implementation
}

// Add to executeTool() switch statement
case 'search_case_law':
    return await this.searchCaseLaw(args);
```

---

## Next Steps

1. **Enable agent in production** once comfortable with monitoring
2. **Collect outcomes data** for learning
3. **Fine-tune system prompt** based on success/failure patterns
4. **Add more tools** as needed (e.g., portal submissions, payment handling)
5. **Upgrade to GPT-5** when available for better reasoning
6. **Implement reinforcement learning** based on outcomes

---

## Support

**Questions?**
- Check logs in Railway dashboard
- Review `agent_decisions` table for reasoning
- Check Discord for escalation alerts
- Query `pending_escalations` view for cases needing review

**Issues?**
- Agent making bad decisions → Adjust system prompt
- Too many escalations → Lower escalation threshold
- Too few escalations → Agent may be overconfident, raise threshold
- High costs → Reduce max iterations or use cheaper model for simple tasks
