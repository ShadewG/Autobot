# FOIA Agent - Complete Testing Guide

**Last Updated:** 2025-11-07
**Agent Version:** Phase 1 (Hybrid Approach)

This guide provides step-by-step instructions to test every feature and response type of the FOIA Case Manager Agent.

---

## 📋 Pre-Test Setup

### Step 1: Run Database Migration

```bash
# From Railway console or local terminal
cd "/Users/samuelhylton/Documents/gits/Autobot MVP"
node run-migration.js migrations/add-agent-tables.sql
```

**Expected Output:**
```
✓ Tables created:
  - agent_decisions
  - escalations

✓ Views created:
  - pending_escalations
  - agent_performance

🎉 Migration complete!
```

**Verify:**
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM agent_decisions;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM escalations;"
```

Should return `count: 0` for both (empty tables).

---

### Step 2: Configure Environment Variables

In **Railway Dashboard** → Your Service → Variables:

```bash
# PHASE 1: Start with agent DISABLED
ENABLE_AGENT=false                    # ← Start here for safety

# Enable notifications
ENABLE_NOTIFICATIONS=true

# Optional: Discord webhook for escalation alerts
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN

# Already set (but verify)
OPENAI_API_KEY=sk-...
SENDGRID_API_KEY=SG.......
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
```

**Get Discord Webhook:**
1. Discord Server → Settings → Integrations → Webhooks
2. Create Webhook → Name it "FOIA Escalations"
3. Copy Webhook URL
4. Paste into Railway

**Redeploy** after setting variables (Railway auto-deploys).

---

### Step 3: Verify Deployment

Check Railway logs for:
```
✅ Redis connected successfully
✅ Database connection pool created
📧 Analysis worker started
📧 Email worker started
📧 Generate worker started
```

If you see errors, troubleshoot before continuing.

---

## 🧪 Test Suite

---

## TEST 1: Agent Disabled - Verify Deterministic Flow Works

**Goal:** Confirm system works with agent OFF, and correctly identifies complex cases.

### 1.1: Send Test Email

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/test/send-and-reply \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Test email sent!",
  "case_id": 28,
  "message_id": "<test-...@foib-request.com>",
  "sent_to": "overlord1pvp@gmail.com",
  "instructions": [
    "1. Check overlord1pvp@gmail.com for the test email",
    "2. Reply with any message",
    "3. The bot will instantly analyze and auto-reply",
    "4. Check for the auto-reply in your inbox!"
  ]
}
```

**Verify in Database:**
```sql
SELECT id, case_name, status, agency_email FROM cases ORDER BY id DESC LIMIT 1;
-- Should show: Auto-Reply Test Case, sent, overlord1pvp@gmail.com

SELECT id, direction, subject, from_email, to_email FROM messages WHERE case_id = 28;
-- Should show: 1 outbound message
```

---

### 1.2: Reply with Denial

1. Check email at `overlord1pvp@gmail.com`
2. Find email with subject: `[TEST] Public Records Request - Auto-Reply Test`
3. **Reply with:** `"Your request is denied due to an ongoing investigation."`
4. Wait 30-60 seconds

**Check Railway Logs:**
```
📧 Analyzing message from: overlord1pvp@gmail.com
   Subject: Re: [TEST] Public Records Request
   Intent: denial
   Requires action: true

🤖 Agent Status:
   Agent enabled: false          ← Agent is OFF
   Complex case: true            ← System recognizes denial
   Reason: denial

ℹ️ Agent disabled, using deterministic flow
🤖 Generating auto-reply...
```

**Expected Behavior:**
- Uses deterministic flow (original code)
- Generates auto-reply using `aiService.generateAutoReply()`
- Queues reply to send instantly (test mode)

**Verify Response:**
```sql
SELECT COUNT(*) FROM messages WHERE case_id = 28;
-- Should be: 2 (1 outbound, 1 inbound)

SELECT * FROM response_analysis WHERE case_id = 28;
-- Should show: intent = 'denial'
```

---

### 1.3: Verify Complex Case Detection

Check logs to confirm system identifies these as complex:

**Test different responses:**

| Reply Text | Expected Intent | Complex? |
|------------|----------------|----------|
| "Request denied - ongoing investigation" | denial | ✅ Yes |
| "We need more information about the incident" | request_info | ✅ Yes |
| "Processing fee will be $250" | fee_notice | ✅ Yes (>$100) |
| "Your request is approved" | approval | ❌ No |
| "We received your request" | acknowledgment | ❌ No |

Each should show in logs:
```
Complex case: true/false
Reason: <intent>
```

---

## TEST 2: Enable Agent - Test Basic Functionality

**Goal:** Enable agent and verify it handles cases correctly.

### 2.1: Enable Agent

Railway → Variables:
```bash
ENABLE_AGENT=true  # ← Change to true
```

Wait for deployment (~2 minutes).

**Check logs for:**
```
✅ Service restarted
```

---

### 2.2: Send New Test Email

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/test/send-and-reply
```

This creates a fresh test case (let's say case_id = 29).

---

### 2.3: Reply with Denial

Reply to the email with:
```
"Your request is denied. The records you requested are exempt from disclosure under 5 U.S.C. § 552(b)(7)(A) as they are part of an ongoing law enforcement investigation."
```

**Check Railway Logs (Agent Execution):**

```
📧 Analyzing message from: overlord1pvp@gmail.com
   Intent: denial

🤖 Agent Status:
   Agent enabled: true
   Complex case: true
   Reason: denial

🚀 Delegating to FOIA Agent for complex case handling...

🤖 FOIA Agent handling case 29
   Trigger: agency_reply

🔄 Agent iteration 1/5
   🛠️ Agent calling 1 tool(s)
      → fetch_case_context({"case_id":29})
      📊 Fetching context for case 29

🔄 Agent iteration 2/5
   🛠️ Agent calling 3 tool(s)
      → draft_denial_rebuttal({"case_id":29,"message_id":52})
      ✍️ Drafting denial rebuttal for case 29
      → send_email({"case_id":29,"subject":"Re: ...","delay_hours":4,...})
      📧 Scheduling email for case 29 (4h delay)
      → log_decision({"case_id":29,"reasoning":"...","action_taken":"drafted_rebuttal","confidence":0.85})
      📝 Logging decision for case 29

✅ Agent handling complete
   Iterations: 2
```

**What Agent Did:**
1. ✅ Fetched case context (all messages, analysis, case details)
2. ✅ Drafted denial rebuttal (researched state laws + generated response)
3. ✅ Scheduled email to send in 4 hours
4. ✅ Logged decision with reasoning

---

### 2.4: Verify Agent Decision Logged

```sql
SELECT
    case_id,
    reasoning,
    action_taken,
    confidence,
    created_at
FROM agent_decisions
WHERE case_id = 29
ORDER BY created_at DESC
LIMIT 1;
```

**Expected:**
```
case_id: 29
reasoning: "Denial cites exemption 7(a) for ongoing investigation. This is a common over-broad claim..."
action_taken: "drafted_rebuttal_and_scheduled_send"
confidence: 0.85
created_at: 2025-11-07 ...
```

---

### 2.5: Verify Email Queued

```sql
SELECT
    id,
    direction,
    message_type,
    subject,
    created_at
FROM messages
WHERE case_id = 29
ORDER BY created_at DESC;
```

**Expected:**
```
Row 1: direction='inbound', message_type='agency_response' (the denial)
Row 2: direction='outbound', message_type='auto_reply' (scheduled rebuttal)
```

Check BullMQ queue:
```bash
# In Railway console or Redis CLI
redis-cli -u $REDIS_URL
LLEN bull:email-queue:wait
# Should show 1 (the queued email)
```

---

### 2.6: Verify Case Status Updated

```sql
SELECT id, status, agent_handled FROM cases WHERE id = 29;
```

**Expected:**
```
status: 'needs_rebuttal' or 'awaiting_response'
agent_handled: true  ← Marked as agent-handled
```

---

## TEST 3: Agent Escalation - High Fee

**Goal:** Verify agent escalates high-value fees to humans.

### 3.1: Send New Test Email

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/test/send-and-reply
```

New case_id = 30.

---

### 3.2: Reply with High Fee

Reply to email with:
```
"Your request has been received. The estimated cost for processing and copying the requested records is $500. Please confirm if you wish to proceed."
```

**Check Logs:**

```
📧 Analyzing message
   Intent: fee_notice
   Extracted fee: $500

🤖 Agent Status:
   Agent enabled: true
   Complex case: true
   Reason: fee_notice ($500)

🚀 Delegating to FOIA Agent...

🔄 Agent iteration 1/5
   → fetch_case_context({"case_id":30})

🔄 Agent iteration 2/5
   → escalate_to_human({
       "case_id": 30,
       "reason": "Fee of $500 requires human decision. Need to evaluate if reasonable for requested records.",
       "urgency": "medium",
       "suggested_action": "Review fee breakdown and decide whether to pay, negotiate, or challenge as excessive"
   })
   🚨 Escalating case 30 to human (medium urgency)
   📢 Sending escalation notification
   ✅ Discord notification sent

   → log_decision(...)
```

---

### 3.3: Verify Discord Notification

Check your Discord channel for:

```
⚠️ FOIA Case Escalation
Case #30 needs human review

Case Name: Auto-Reply Test Case
Agency: Test Agency
Urgency: MEDIUM

Reason: Fee of $500 requires human decision. Need to evaluate if reasonable for requested records.

💡 Suggested Action: Review fee breakdown and decide whether to pay, negotiate, or challenge as excessive

🔗 View Case: https://your-app.railway.app/api/cases/30
```

---

### 3.4: Verify Escalation in Database

```sql
SELECT * FROM escalations WHERE case_id = 30;
```

**Expected:**
```
case_id: 30
reason: "Fee of $500 requires human decision..."
urgency: medium
status: pending
created_at: ...
```

**Check pending escalations view:**
```sql
SELECT * FROM pending_escalations;
```

Should show case 30 with urgency and reason.

---

### 3.5: Verify Case Status

```sql
SELECT status, escalation_reason FROM cases WHERE id = 30;
```

**Expected:**
```
status: 'needs_human_review'
escalation_reason: "Fee of $500 requires human decision..."
```

---

## TEST 4: Agent Handles Clarification Request

**Goal:** Verify agent responds to requests for more information.

### 4.1: Send New Test Email

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/test/send-and-reply
```

New case_id = 31.

---

### 4.2: Reply Requesting Clarification

Reply with:
```
"We need more specific information to process your request. Please clarify:
1. What is the exact date range you're requesting?
2. What specific incident are you referring to?
3. Are you requesting body camera footage or just reports?"
```

**Check Logs:**

```
📧 Analyzing message
   Intent: request_info

🤖 Agent Status:
   Complex case: true
   Reason: request_info

🔄 Agent iteration 1/5
   → fetch_case_context(...)

🔄 Agent iteration 2/5
   → draft_clarification({"case_id":31,"message_id":54})
      ✍️ Drafting clarification for case 31
   → send_email({"delay_hours":3,...})
      📧 Scheduling email for case 31 (3h delay)
   → log_decision(...)
```

**What Agent Did:**
1. ✅ Recognized need for clarification
2. ✅ Drafted response providing requested details
3. ✅ Scheduled send with 3-hour delay

---

### 4.3: Verify Clarification Email Content

```sql
SELECT body_text FROM messages
WHERE case_id = 31 AND direction = 'outbound' AND message_type = 'auto_reply'
LIMIT 1;
```

Should contain:
- Specific date range
- Incident details from case
- Clear list of records requested

---

## TEST 5: Error Handling - Case Context Fails

**Goal:** Verify agent escalates when it can't load case data.

### 5.1: Trigger Agent with Non-Existent Case

Create a test script or use Railway console:

```javascript
// In Railway console
const foiaCaseAgent = require('./services/foia-case-agent');

await foiaCaseAgent.handleCase(99999, {
    type: 'agency_reply',
    messageId: null
});
```

**Check Logs:**

```
🤖 FOIA Agent handling case 99999
   Trigger: agency_reply

🔄 Agent iteration 1/5
   → fetch_case_context({"case_id":99999})
      📊 Fetching context for case 99999
      ❌ Error: Case not found

   [System intervention]: fetch_case_context returned an error: Case not found.
   Call escalate_to_human with urgency 'high' explaining that case context could not be loaded.

🔄 Agent iteration 2/5
   → escalate_to_human({
       "case_id": 99999,
       "reason": "Unable to load case context - database may be unavailable or case doesn't exist",
       "urgency": "high"
   })
   🚨 Escalating case 99999
```

**Result:** ✅ Agent doesn't crash, escalates properly

---

## TEST 6: Error Handling - Bad Tool Arguments

**Goal:** Verify agent handles JSON parsing errors gracefully.

This is harder to trigger naturally (GPT-4o usually sends valid JSON), but your code handles it:

```javascript
// Your error handling
try {
    functionArgs = JSON.parse(toolCall.function.arguments);
} catch (parseError) {
    // Returns error to agent, doesn't crash
}
```

**To test:** Manually modify tool response in code temporarily or wait for GPT-4o to mess up (rare).

**Expected behavior:**
- Error logged
- Error sent back to agent
- Agent continues with other tools

---

## TEST 7: Decision Logging Fallback

**Goal:** Verify fallback logging works if agent doesn't call log_decision.

### 7.1: Temporarily Disable log_decision Reminder

Comment out the reminder in `foia-case-agent.js` lines 447-453:

```javascript
// if (!decisionLogged && !decisionReminderSent) {
//     decisionReminderSent = true;
//     messages.push({
//         role: 'system',
//         content: 'You have not yet called log_decision...'
//     });
// }
```

---

### 7.2: Trigger Agent

Send test email and reply with any denial.

**Check Logs:**

```
✅ Agent completed
   Iterations: 2

⚠️ Agent finished without logging a decision, recording fallback entry
📝 Logging decision for case 32
```

**Verify in Database:**

```sql
SELECT reasoning, action_taken, confidence FROM agent_decisions WHERE case_id = 32;
```

**Expected:**
```
reasoning: "Agent completed without explicitly calling log_decision."
action_taken: "unknown"
confidence: 0.0  ← Clearly indicates fallback
```

**Re-enable the reminder** after testing!

---

## TEST 8: Delay Hour Validation

**Goal:** Verify delay hours are clamped to 2-10h range.

### 8.1: Agent Tries Instant Send (delay_hours = 0)

This requires agent to choose delay_hours < 2 (unlikely, but handled).

**Your code:**
```javascript
if (delay < 2) {
    console.warn(`⚠️ delay_hours ${delay} below minimum, clamping to 2`);
    delay = 2;
}
```

**Check logs for:**
```
⚠️ delay_hours 0 below minimum, clamping to 2
📧 Scheduling email for case X (2h delay)
```

---

### 8.2: Agent Tries Very Long Delay (delay_hours = 24)

**Expected:**
```
⚠️ delay_hours 24 above maximum, clamping to 10
📧 Scheduling email for case X (10h delay)
```

---

## TEST 9: Expensive Tool Guard Rail

**Goal:** Verify agent is warned after 2 expensive tool calls.

### 9.1: Trigger Multiple Drafts

This is hard to trigger naturally, but if agent drafts multiple times:

**Expected Logs:**
```
🔄 Agent iteration 2/5
   → draft_denial_rebuttal(...)  ← 1st expensive call

🔄 Agent iteration 3/5
   → draft_clarification(...)     ← 2nd expensive call

🔄 Agent iteration 4/5
   ⚠️ Warning: Agent has called expensive tools 3 times
   [System message]: You have already drafted multiple emails.
   Do not draft another unless there is genuinely new information...
```

Agent should then stop drafting and either send or escalate.

---

## TEST 10: Multiple Trigger Types

**Goal:** Verify agent behaves differently based on trigger type.

### 10.1: Agency Reply Trigger (already tested)

```javascript
await foiaCaseAgent.handleCase(caseId, {
    type: 'agency_reply',
    messageId: 55
});
```

Agent focuses on analyzing response and deciding how to reply.

---

### 10.2: Time-Based Follow-Up Trigger

```javascript
await foiaCaseAgent.handleCase(caseId, {
    type: 'time_based_followup',
    messageId: null
});
```

**Expected Agent Behavior:**
- Checks if response was received (if yes, cancel follow-up)
- Checks state deadline laws
- Decides whether to send follow-up or escalate
- Doesn't re-analyze old denials

**System prompt tells agent:**
```
For time_based_followup, focus on deadlines and whether to follow up.
```

---

### 10.3: Manual Review Trigger

```javascript
await foiaCaseAgent.handleCase(caseId, {
    type: 'manual_review',
    messageId: null
});
```

Human manually invoked agent for second look.

**Expected:** Agent reviews entire case history and suggests next action.

---

## 📊 Performance Metrics

After running tests, check agent performance:

### View All Decisions

```sql
SELECT
    ad.case_id,
    c.case_name,
    ad.reasoning,
    ad.action_taken,
    ad.confidence,
    ad.created_at
FROM agent_decisions ad
JOIN cases c ON ad.case_id = c.id
ORDER BY ad.created_at DESC
LIMIT 20;
```

### View Escalations

```sql
SELECT * FROM pending_escalations ORDER BY created_at DESC;
```

### Agent Performance Over Time

```sql
SELECT * FROM agent_performance
WHERE decision_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY decision_date DESC;
```

---

## ✅ Test Summary Checklist

### Phase 1: Agent Disabled
- [ ] Test email sends successfully
- [ ] Inbound webhook receives replies
- [ ] System identifies complex cases (logs show "Complex case: true")
- [ ] Deterministic flow works (generates auto-replies)

### Phase 2: Agent Enabled
- [ ] Agent handles denials (drafts rebuttal, logs decision)
- [ ] Agent escalates high fees (creates escalation, sends Discord alert)
- [ ] Agent handles clarification requests (drafts response)
- [ ] Decision logging works (every run has entry in agent_decisions)
- [ ] Emails queued with correct delays (2-10h range)
- [ ] Case status updated correctly
- [ ] agent_handled flag set to true

### Phase 3: Error Handling
- [ ] Case context error triggers escalation (not crash)
- [ ] Bad tool arguments handled gracefully
- [ ] Decision logging fallback works
- [ ] Delay hours clamped to 2-10h range
- [ ] Expensive tool guard rail activates after 2 drafts

### Phase 4: Notifications
- [ ] Discord notifications sent for escalations
- [ ] Notifications include urgency, reason, suggested action
- [ ] pending_escalations view populated correctly

### Phase 5: Different Triggers
- [ ] agency_reply trigger works (analyzes response)
- [ ] time_based_followup trigger works (checks deadlines)
- [ ] manual_review trigger works (reviews full case)

---

## 🐛 Troubleshooting

### Agent Not Running

**Symptom:** Logs show "Agent disabled" even though `ENABLE_AGENT=true`

**Check:**
```bash
# Railway console
echo $ENABLE_AGENT
# Should output: true
```

If it says `false`, redeploy after setting variable.

---

### No Decision Logged

**Symptom:** `agent_decisions` table empty after agent runs

**Check logs for:**
```
⚠️ Agent finished without logging, recording fallback entry
```

If you see this, fallback worked (confidence = 0.0).

If you don't see ANY log entries, agent may have crashed. Check for error logs.

---

### Escalations Not Sending to Discord

**Symptom:** Escalation created in DB but no Discord message

**Check:**
```bash
echo $DISCORD_WEBHOOK_URL
# Should be: https://discord.com/api/webhooks/...

echo $ENABLE_NOTIFICATIONS
# Should be: true
```

**Check logs for:**
```
ℹ️ Notifications disabled, skipping escalation alert
```

If notifications are enabled but still not sending, check webhook URL is valid.

---

### Emails Not Sending

**Symptom:** Emails queued but never sent

**Check:**
```bash
# Check if email worker is running
# Railway logs should show:
📧 Email worker started

# Check queue
redis-cli -u $REDIS_URL
LLEN bull:email-queue:wait
# Should show count of pending emails
```

If queue is growing but not processing, email worker may have crashed. Check logs.

---

### Agent Taking Too Long

**Symptom:** Agent reaches 5 iteration limit

**Check logs for:**
```
⚠️ Agent reached max iterations (5)
```

This means agent is looping. Check what tools it's calling repeatedly.

**Common causes:**
- Agent stuck in decision loop
- Tool returning errors repeatedly
- Agent not understanding task

**Solution:** Review agent_decisions reasoning to see what it's trying to do.

---

## 🎯 Next Steps After Testing

Once all tests pass:

1. **Review Agent Decisions**
   - Check reasoning quality
   - Look for patterns in confidence scores
   - Identify common actions taken

2. **Adjust System Prompt** (if needed)
   - If agent escalates too often → Raise threshold
   - If agent doesn't escalate enough → Lower threshold
   - If reasoning is unclear → Add more guidance

3. **Monitor in Production**
   - Set up daily summary notifications
   - Review escalations weekly
   - Track success rates by agency/state

4. **Upgrade Model** (when available)
   - Switch from gpt-4o to gpt-5
   - Re-run tests to compare performance
   - Adjust reasoning_effort parameter

5. **Add More Tools** (future)
   - Portal submission tool
   - Payment processing tool
   - Document search tool
   - Case law search tool

---

## 📞 Support

**Issues?**
- Check Railway logs first
- Review agent_decisions table for reasoning
- Check pending_escalations for stuck cases
- Review this guide's troubleshooting section

**Want to customize?**
- Edit system prompt: `services/foia-case-agent.js` lines 25-93
- Add new tools: `getToolDefinitions()` + implement in `executeTool()`
- Adjust complexity threshold: `queues/email-queue.js` lines 189-195
