#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Testing SendGrid API Directly ==="
echo ""
echo "Test 1: Sending from requests@foia.foib-request.com"
echo ""

curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}]
    }],
    "from": {
      "email": "requests@foia.foib-request.com",
      "name": "FOIA Request Team"
    },
    "subject": "SendGrid Test",
    "content": [{
      "type": "text/plain",
      "value": "Testing SendGrid"
    }]
  }' \
  -w "\n\nHTTP Status: %{http_code}\n"

echo ""
echo ""
echo "Test 2: Sending from samuel@drinsanity.com"
echo ""

curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}]
    }],
    "from": {
      "email": "samuel@drinsanity.com",
      "name": "Dr Insanity"
    },
    "subject": "SendGrid Test 2",
    "content": [{
      "type": "text/plain",
      "value": "Testing SendGrid from drinsanity.com"
    }]
  }' \
  -w "\n\nHTTP Status: %{http_code}\n"
