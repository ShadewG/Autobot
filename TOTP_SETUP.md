# TOTP/2FA Email Verification Setup

This guide explains how to automatically forward verification codes to Skyvern so portal automation can complete email verification steps.

## How It Works

1. **Portal sends verification email** → `requests@foib-request.com`
2. **Gmail filter detects verification emails** → Forwards to Zapier email
3. **Zapier webhook** → Sends to Skyvern TOTP API
4. **Skyvern extracts code** → Uses it to complete verification automatically

## Current Status

✅ **Code updated**: All Skyvern tasks now include `totp_identifier: "requests@foib-request.com"`

⏳ **Pending setup**: Email forwarding automation (Gmail + Zapier)

## Setup Steps (Gmail + Zapier)

### Prerequisites
- Zapier Pro account (required for webhook features)
- Access to `requests@foib-request.com` Gmail account
- Skyvern API key (already configured in Railway env vars)

### Step 1: Create Zapier Automation

1. Go to https://zapier.com/app/home
2. Create new Zap
3. **Trigger**: Email by Zapier
   - Event: "New Inbound Email"
   - Create a dedicated email address (e.g., `skyvern-totp-123@zapiermail.com`)
   - Save this email address

### Step 2: Configure Zapier Webhook Action

1. Add Action: "Webhooks by Zapier"
2. Event: "POST"
3. Configure:
   - **URL**: `https://api.skyvern.com/api/v1/totp`
   - **Payload Type**: json
   - **Data**:
     - `totp_identifier`: Choose "Raw To Email" (the Gmail address)
     - `content`: Choose "Body Plain" (email body text)
     - `source`: `email` (literal string)
   - **Headers**:
     - `x-api-key`: Your Skyvern API key from Railway env vars

4. Test the webhook to verify it works

### Step 3: Set Up Gmail Forwarding

1. Go to Gmail Settings → Forwarding and POP/IMAP
   - https://mail.google.com/mail/u/0/#settings/fwdandpop

2. Click "Add a forwarding address"
   - Enter the Zapier email from Step 1
   - Verify the forwarding address (check inbox for verification email)

3. Go to "Filters and Blocked Addresses"
   - https://mail.google.com/mail/u/0/#settings/filters

4. Click "Create a new filter"
   - **From**: Leave empty (we want all verification emails)
   - **Subject**: `verification` OR `code` OR `confirm`
   - **Has the words**: `verification code`
   - Click "Create filter"

5. Configure filter actions:
   - ✅ Check "Forward it to"
   - Select the Zapier email address
   - ✅ Check "Skip the Inbox (Archive it)" (optional - keeps inbox clean)
   - Click "Create filter"

### Step 4: Test End-to-End

1. Find a previous verification email in Gmail
2. Forward it to the Zapier email address
3. Check Zapier dashboard → should see successful run
4. Check Skyvern logs → verification code should be stored

## Email Filter Examples

### Broad Filter (Catches Most Verification Emails)
```
Subject: (verification OR code OR confirm OR 2FA OR OTP)
Has the words: code
```

### Specific Portals Only
```
From: (noreply@nextrequest.com OR verify@govqa.com OR notifications@granicus.com)
Subject: verification
```

### Recommended Starting Filter
```
Subject: (verification code OR confirmation code)
```

## Testing Portal TOTP

Once setup is complete, test with a portal that requires email verification:

```bash
curl -X POST "https://sincere-strength-production.up.railway.app/api/test/set-portal-url" \
  -H "Content-Type: application/json" \
  -d '{
    "case_id": 57,
    "portal_url": "https://raleighnc.nextrequest.com/",
    "portal_provider": "NextRequest"
  }'
```

Watch for:
1. Portal task starts in Skyvern
2. Verification email arrives at `requests@foib-request.com`
3. Email forwarded to Zapier → Skyvern TOTP API
4. Skyvern extracts code and completes verification
5. Portal account created successfully

## Troubleshooting

### Verification emails not being forwarded
- Check Gmail filter is active
- Verify Zapier email is in forwarding addresses
- Check spam/promotions folders

### Zapier webhook failing
- Verify Skyvern API key is correct
- Check Zapier logs for error details
- Ensure payload matches expected format

### Skyvern not using verification code
- Check Skyvern task logs for TOTP retrieval attempts
- Verify `totp_identifier` matches Gmail address exactly
- Check code hasn't expired (usually 5-10 minute expiry)

## Environment Variables

Ensure these are set in Railway:

```bash
SKYVERN_API_KEY=your_skyvern_api_key
REQUESTS_INBOX=requests@foib-request.com
```

## Manual TOTP Endpoint (Alternative to Zapier)

If you prefer custom automation instead of Zapier:

```bash
POST https://api.skyvern.com/api/v1/totp
Headers:
  x-api-key: YOUR_SKYVERN_API_KEY
  Content-Type: application/json

Body:
{
  "totp_identifier": "requests@foib-request.com",
  "content": "Your verification code is: 123456",
  "source": "email",
  "task_id": "tsk_optional_task_id"
}
```

You could build a custom webhook with:
- AWS Lambda + SES email receiving
- Google Cloud Functions + Gmail API
- N8N workflow automation
- Make.com (Integromat)
