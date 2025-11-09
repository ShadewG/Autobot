#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Sending Test Email NOW ==="
echo "From: requests@em7571.foib-request.com"
echo "To: shadewofficial@gmail.com"
echo ""

curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "✅ FOIA System Test - Email Working!"
    }],
    "from": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "reply_to": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "content": [{
      "type": "text/html",
      "value": "<html><body><h2>✅ Success! Your FOIA email system is working!</h2><p><strong>From:</strong> requests@em7571.foib-request.com</p><p><strong>Authenticated Domain:</strong> em7571.foib-request.com</p><p><strong>Reply-To:</strong> requests@em7571.foib-request.com</p><hr><p>This email confirms that:</p><ul><li>✅ SendGrid authentication is working</li><li>✅ Domain em7571.foib-request.com is properly configured</li><li>✅ DKIM/SPF signatures are valid</li><li>✅ Outbound emails are functioning</li></ul><p><strong>Next step:</strong> Reply to this email to test the inbound webhook!</p><p style=\"color: #666; font-size: 12px; margin-top: 30px;\">🤖 Sent via SendGrid API with authenticated domain</p></body></html>"
    }]
  }' \
  -s -o /tmp/sendgrid-response.json -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "Response:"
cat /tmp/sendgrid-response.json | python3 -m json.tool 2>/dev/null || cat /tmp/sendgrid-response.json
echo ""
