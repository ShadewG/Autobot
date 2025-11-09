#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Testing Authenticated Domain: em7571.foib-request.com ==="
echo ""

curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}]
    }],
    "from": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "reply_to": {
      "email": "requests@em7571.foib-request.com"
    },
    "subject": "SendGrid Test - Authenticated Domain",
    "content": [{
      "type": "text/plain",
      "value": "Testing from authenticated domain em7571.foib-request.com"
    }]
  }' \
  -w "\n\nHTTP Status: %{http_code}\n"
