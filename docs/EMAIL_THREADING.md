# Email Threading & Auto-Reply System

## How Email Threading Works

### Thread Tracking with RFC 2822 Headers

Every email sent/received uses standard email headers to maintain conversation threads:

```javascript
{
  'Message-ID': '<1234567890.abc123@autobot.local>',      // Unique ID for this message
  'In-Reply-To': '<case-123-1234567800@autobot.local>',   // ID of message we're replying to
  'References': '<case-123-1234567800@autobot.local>'     // Thread ID (all messages reference this)
}
```

**How It Works:**

1. **Initial Request** (`sendgrid-service.js:24-50`)
   ```javascript
   const messageId = generateMessageId();  // <timestamp.random@autobot.local>
   const threadId = generateThreadId(caseId);  // <case-123-timestamp@autobot.local>

   headers: {
     'Message-ID': messageId,
     'In-Reply-To': threadId,
     'References': threadId
   }
   ```

2. **Agency Replies** (`sendgrid-service.js:193-268`)
   - Agency's email client automatically includes `In-Reply-To` and `References`
   - Webhook receives these headers
   - System matches to case using References header
   - Stores message in same thread

3. **Auto-Replies** (`sendgrid-service.js:141-188`)
   ```javascript
   headers: {
     'Message-ID': newMessageId,
     'In-Reply-To': theirMessageId,   // Reply to their specific message
     'References': threadId            // Keep thread intact
   }
   ```

### Thread Matching Algorithm

**Priority Order:**

1. **By Thread ID** (`sendgrid-service.js:275-283`)
   ```sql
   SELECT case_id FROM messages
   WHERE message_id = $1 OR thread_id = $2
   ```
   - Most reliable: matches via References header
   - Works even if subject changes

2. **By Agency Email** (`sendgrid-service.js:286-292`)
   ```sql
   SELECT * FROM cases
   WHERE agency_email = $1
     AND status IN ('sent', 'awaiting_response')
   ORDER BY created_at DESC
   ```
   - Fallback if headers missing
   - Matches most recent active case

### Database Schema

**Email Threads Table:**
```sql
CREATE TABLE email_threads (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id),
    thread_id VARCHAR(255) UNIQUE,       -- References header value
    subject TEXT,
    agency_email VARCHAR(255),
    initial_message_id VARCHAR(255),
    message_count INTEGER DEFAULT 0,
    last_message_at TIMESTAMP,
    status VARCHAR(50) DEFAULT 'active'  -- active, responded, closed
);
```

**Messages Table:**
```sql
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER REFERENCES email_threads(id),
    case_id INTEGER REFERENCES cases(id),
    message_id VARCHAR(255) UNIQUE,       -- Message-ID header
    sendgrid_message_id VARCHAR(255),     -- SendGrid's tracking ID
    direction VARCHAR(20),                -- inbound or outbound
    from_email VARCHAR(255),
    to_email VARCHAR(255),
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    message_type VARCHAR(50),             -- initial_request, response, follow_up, auto_reply
    has_attachments BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP,
    received_at TIMESTAMP
);
```

## Auto-Reply System

### Workflow

```
┌─────────────────────┐
│ Agency Sends Email  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ SendGrid Webhook    │ → POST /webhooks/inbound
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Match to Case       │ → Find thread via References header
│ Store Message       │ → Save in database
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Queue Analysis      │ → 5 second delay
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ GPT-5-mini Analyze │ → Extract intent, sentiment, deadlines
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check if Action     │
│ Required?           │
└──────────┬──────────┘
           │
           ├─── YES ──→ ┌─────────────────────┐
           │            │ Generate Auto-Reply  │ → GPT-5-mini
           │            └──────────┬──────────┘
           │                       │
           │                       ▼
           │            ┌─────────────────────┐
           │            │ Confidence >= 0.8?  │
           │            └──────────┬──────────┘
           │                       │
           │                       ├─── YES ──→ Queue with 2-10 hour delay
           │                       │
           │                       └─── NO ───→ Store for human approval
           │
           └─── NO ───→ Just record outcome for learning
```

### Natural Timing

**Business Hours (9am-5pm):**
```javascript
delay = (2 + Math.random() * 2) * 60 * 60 * 1000  // 2-4 hours
```

**Outside Business Hours:**
```javascript
// Wait until 9-11am next business day
tomorrow.setHours(9 + Math.random() * 2, Math.random() * 60, 0, 0)
```

**Why Human-Like Delays?**
- Immediate replies look automated
- 2-10 hour delay seems like busy human
- Business hours timing increases legitimacy
- Avoids triggering spam filters

### System Prompts for Auto-Reply

**Analysis Prompt** (`ai-service.js:144-183`)
```javascript
systemPrompt: "You are an AI that analyzes FOIA response emails. Always return valid JSON."

userPrompt: `Analyze this email response to a FOIA request and extract:
1. intent: (acknowledgment | question | delivery | denial | fee_request | more_info_needed)
2. confidence_score: 0.0 to 1.0
3. sentiment: (positive | neutral | negative | hostile)
4. key_points: array of important points
5. extracted_deadline: any deadline mentioned
6. extracted_fee_amount: any fee amount
7. requires_action: does this require a response?
8. suggested_action: what should we do next?
`
```

**Auto-Reply Generation** (`ai-service.js:213-262`)
```javascript
systemPrompt: "You are an AI that writes professional FOIA correspondence. Be polite, clear, and efficient."

userPrompt: `Generate a professional email reply to this FOIA response:

**Context:**
- Our request was about: ${caseData.subject_name}
- Agency: ${caseData.agency_name}

**Their Response:**
${messageData.body_text}

**Analysis:**
- Intent: ${analysis.intent}
- What they need: ${analysis.suggested_action}

Generate an appropriate reply that:
1. Is professional and courteous
2. Addresses their specific questions/needs
3. Provides any information they requested
4. Confirms our continued interest in receiving the records
5. Is concise and clear
`
```

### Confidence Scoring

**High Confidence (≥0.8):** Auto-send with delay
- Acknowledgment responses
- Simple fee requests
- Requests for basic info

**Low Confidence (<0.8):** Store for approval
- Denials (need legal review)
- Complex questions
- Hostile/negative sentiment
- Unusual requests

## Example Flow

### Scenario: Fee Request

**1. Agency Sends Email:**
```
From: foia@oaklandpd.gov
To: requests@yourdomain.com
Subject: Re: FOIA Request - Marcus Johnson Body Camera Footage
References: <case-123-1698765432@autobot.local>

Hello,

We can process your request. There will be a $25 processing fee.
Please confirm if you wish to proceed.

Records Clerk
Oakland PD
```

**2. Webhook Received:**
```javascript
POST /webhooks/inbound
{
  from: "foia@oaklandpd.gov",
  subject: "Re: FOIA Request...",
  headers: {
    "References": "<case-123-1698765432@autobot.local>"
  }
}
```

**3. Thread Matched:**
```sql
-- Finds case 123 via References header
SELECT case_id FROM messages WHERE thread_id = 'case-123-1698765432@autobot.local'
-- Returns: case_id = 123
```

**4. Message Stored:**
```sql
INSERT INTO messages (
  thread_id, case_id, message_id, direction, from_email, body_text, message_type
) VALUES (
  45, 123, '<msg-xyz@oaklandpd.gov>', 'inbound', 'foia@oaklandpd.gov', '...', 'response'
)
```

**5. Analysis Queued:**
```javascript
analysisQueue.add('analyze-response', {
  messageId: 789,
  caseId: 123
}, { delay: 5000 })  // 5 second delay
```

**6. GPT-5-mini Analyzes:**
```json
{
  "intent": "fee_request",
  "confidence_score": 0.95,
  "sentiment": "neutral",
  "key_points": ["$25 processing fee", "Needs confirmation"],
  "extracted_fee_amount": 25,
  "requires_action": true,
  "suggested_action": "Confirm willingness to pay fee"
}
```

**7. Auto-Reply Generated:**
```
Dear Records Clerk,

Thank you for your prompt response. We confirm our willingness
to proceed with the request and pay the $25 processing fee.

Please let us know the payment method and any additional
information needed to complete this request.

Best regards,
Samuel Hylton
MATCHER Legal Department
```

**8. Reply Queued with Natural Delay:**
```javascript
// It's 2pm (business hours)
delay = 3.2 hours  // Random between 2-4 hours

emailQueue.add('send-auto-reply', {
  type: 'auto_reply',
  caseId: 123,
  toEmail: 'foia@oaklandpd.gov',
  subject: 'Re: FOIA Request...',
  content: '...',
  originalMessageId: '<msg-xyz@oaklandpd.gov>'
}, { delay: 11520000 })  // 3.2 hours in milliseconds

console.log('Auto-reply queued for case 123 (will send in 192 minutes)')
```

**9. Reply Sent (3.2 hours later at 5:12pm):**
```javascript
{
  'Message-ID': '<new-msg-id@autobot.local>',
  'In-Reply-To': '<msg-xyz@oaklandpd.gov>',
  'References': '<case-123-1698765432@autobot.local>'
}
```

**10. Thread Updated:**
```sql
UPDATE email_threads SET
  message_count = message_count + 1,
  last_message_at = NOW(),
  status = 'active'
WHERE id = 45
```

## Configuration

### Environment Variables

```bash
# Enable/disable auto-replies (enabled by default)
ENABLE_AUTO_REPLY=true

# Auto-reply confidence threshold (0.0-1.0)
AUTO_REPLY_CONFIDENCE_THRESHOLD=0.8

# SendGrid webhook secret (for verification)
SENDGRID_WEBHOOK_SECRET=your_secret_here
```

### Testing Auto-Replies

**Simulate Inbound Email:**
```bash
curl -X POST http://localhost:3000/webhooks/inbound \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test@agency.gov",
    "to": "requests@yourdomain.com",
    "subject": "Re: FOIA Request - Test",
    "text": "We need your mailing address to process this request.",
    "headers": {
      "Message-ID": "<test-msg@agency.gov>",
      "References": "<case-1-12345@autobot.local>"
    }
  }'
```

**Check Queue:**
```bash
# View pending auto-replies
curl http://localhost:3000/api/queue/email-queue
```

**View Thread:**
```sql
SELECT m.*, t.thread_id, t.message_count
FROM messages m
JOIN email_threads t ON m.thread_id = t.id
WHERE m.case_id = 1
ORDER BY m.created_at DESC;
```

## Monitoring

**Logs to Watch For:**

```
✅ Good:
- "Inbound email matched to case 123"
- "Auto-reply queued for case 123 (will send in 192 minutes)"
- "Auto-reply sent successfully"

⚠️  Needs Review:
- "Auto-reply requires approval for case 123 (confidence: 0.65)"
- "Could not match inbound email to a case"

❌ Errors:
- "Analysis job failed"
- "Error sending auto-reply"
```

**Database Queries:**

```sql
-- View auto-replies pending approval
SELECT * FROM auto_reply_queue WHERE requires_approval = true;

-- Thread statistics
SELECT
  case_id,
  COUNT(*) as message_count,
  MAX(last_message_at) as last_activity
FROM email_threads
GROUP BY case_id;

-- Auto-reply success rate
SELECT
  COUNT(CASE WHEN message_type = 'auto_reply' THEN 1 END) as auto_replies,
  COUNT(CASE WHEN message_type = 'response' THEN 1 END) as responses,
  ROUND(100.0 * COUNT(CASE WHEN message_type = 'auto_reply' THEN 1 END) /
    NULLIF(COUNT(CASE WHEN message_type = 'response' THEN 1 END), 0), 2) as auto_reply_rate
FROM messages;
```

## Summary

**Threading:** ✅ Automatic via RFC 2822 headers
**Matching:** ✅ References header + fallback to agency email
**Auto-Reply:** ✅ Enabled by default with human-like timing
**System Prompts:** ✅ Professional FOIA-focused responses
**Natural Timing:** ✅ 2-10 hour delays, business hours aware
**Confidence:** ✅ High confidence auto-sends, low confidence requires approval

Everything is automatic on Railway - no manual intervention needed!
