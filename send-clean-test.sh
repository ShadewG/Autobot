#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Sending from CLEAN domain: requests@foib-request.com ==="
echo ""

curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "✨ Clean Domain Test - requests@foib-request.com"
    }],
    "from": {
      "email": "requests@foib-request.com",
      "name": "FOIA Request Team"
    },
    "reply_to": {
      "email": "requests@foib-request.com"
    },
    "content": [{
      "type": "text/html",
      "value": "<html><body style=\"font-family: Arial, sans-serif; padding: 20px;\"><div style=\"max-width: 600px; margin: 0 auto; border: 2px solid #2196F3; border-radius: 10px; padding: 20px;\"><h1 style=\"color: #2196F3;\">✨ Clean Domain Working!</h1><p style=\"font-size: 18px;\"><strong>From:</strong> requests@foib-request.com</p><p style=\"font-size: 14px; color: #4CAF50;\">✅ No more em7571 prefix!</p><hr><h3>Email Details:</h3><ul><li><strong>From:</strong> requests@foib-request.com (clean!)</li><li><strong>Reply-To:</strong> requests@foib-request.com</li><li><strong>Authentication:</strong> Via em7571.foib-request.com</li><li><strong>DKIM/SPF:</strong> ✅ Valid</li></ul><div style=\"background: #e3f2fd; padding: 15px; border-radius: 5px; margin-top: 20px; border-left: 4px solid #2196F3;\"><p style=\"margin: 0;\"><strong>🎯 This is what your FOIA requests will look like!</strong></p><p style=\"margin: 10px 0 0 0; color: #666;\">Professional, clean, and trustworthy.</p></div></div></body></html>"
    }]
  }' \
  -s -w "\nStatus: %{http_code}\n"

echo ""
echo "✅ Email sent from requests@foib-request.com"
echo ""
echo "Check your inbox at shadewofficial@gmail.com"
echo "Subject: ✨ Clean Domain Test - requests@foib-request.com"
