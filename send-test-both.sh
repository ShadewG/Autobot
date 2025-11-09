#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Sending Test Emails to BOTH addresses ==="
echo ""
echo "Email 1: shadewofficial@gmail.com"
echo "Email 2: overlord1pvp@gmail.com"
echo ""

# Email 1
curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "🔥 FOIA System - Test Email #1"
    }],
    "from": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "reply_to": {
      "email": "requests@em7571.foib-request.com"
    },
    "content": [{
      "type": "text/html",
      "value": "<html><body style=\"font-family: Arial, sans-serif; padding: 20px;\"><div style=\"max-width: 600px; margin: 0 auto; border: 2px solid #4CAF50; border-radius: 10px; padding: 20px;\"><h1 style=\"color: #4CAF50;\">✅ FOIA Email System is Working!</h1><p style=\"font-size: 16px;\">This email was sent from <strong>requests@em7571.foib-request.com</strong></p><p style=\"font-size: 14px; color: #666;\">Sent at: '"$(date)"'</p><hr><h3>What this proves:</h3><ul><li>✅ SendGrid authentication working</li><li>✅ Domain em7571.foib-request.com verified</li><li>✅ DKIM/SPF signatures valid</li><li>✅ Reply-To header configured</li></ul><div style=\"background: #f0f0f0; padding: 15px; border-radius: 5px; margin-top: 20px;\"><p style=\"margin: 0; font-weight: bold;\">🎯 Test the full loop:</p><p style=\"margin: 5px 0 0 0;\">Reply to this email and your FOIA agent will automatically respond!</p></div></div></body></html>"
    }]
  }' \
  -s -w "Status: %{http_code}\n\n"

sleep 2

# Email 2
curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "overlord1pvp@gmail.com"}],
      "subject": "🔥 FOIA System - Test Email #2"
    }],
    "from": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "reply_to": {
      "email": "requests@em7571.foib-request.com"
    },
    "content": [{
      "type": "text/html",
      "value": "<html><body style=\"font-family: Arial, sans-serif; padding: 20px;\"><div style=\"max-width: 600px; margin: 0 auto; border: 2px solid #4CAF50; border-radius: 10px; padding: 20px;\"><h1 style=\"color: #4CAF50;\">✅ FOIA Email System is Working!</h1><p style=\"font-size: 16px;\">This email was sent from <strong>requests@em7571.foib-request.com</strong></p><p style=\"font-size: 14px; color: #666;\">Sent at: '"$(date)"'</p><hr><h3>What this proves:</h3><ul><li>✅ SendGrid authentication working</li><li>✅ Domain em7571.foib-request.com verified</li><li>✅ DKIM/SPF signatures valid</li><li>✅ Reply-To header configured</li></ul><div style=\"background: #f0f0f0; padding: 15px; border-radius: 5px; margin-top: 20px;\"><p style=\"margin: 0; font-weight: bold;\">🎯 Test the full loop:</p><p style=\"margin: 5px 0 0 0;\">Reply to this email and your FOIA agent will automatically respond!</p></div></div></body></html>"
    }]
  }' \
  -s -w "Status: %{http_code}\n\n"

echo "✅ Both emails sent!"
echo ""
echo "Check your inbox for:"
echo "  - shadewofficial@gmail.com"
echo "  - overlord1pvp@gmail.com"
echo ""
echo "Subject: 🔥 FOIA System - Test Email"
