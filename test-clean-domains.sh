#!/bin/bash

API_KEY=$(grep SENDGRID_API_KEY .env | cut -d'=' -f2)

echo "=== Testing Different Domain Formats ==="
echo ""

# Test 1: Root domain
echo "Test 1: requests@foib-request.com (root domain)"
curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "Test from root domain"
    }],
    "from": {
      "email": "requests@foib-request.com",
      "name": "FOIA Request Team"
    },
    "content": [{
      "type": "text/plain",
      "value": "Testing from root domain"
    }]
  }' \
  -s -w "Status: %{http_code}\n" -o /tmp/test1.json

echo ""
cat /tmp/test1.json
echo ""
echo ""

# Test 2: foia subdomain
echo "Test 2: requests@foia.foib-request.com (foia subdomain)"
curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "Test from foia subdomain"
    }],
    "from": {
      "email": "requests@foia.foib-request.com",
      "name": "FOIA Request Team"
    },
    "content": [{
      "type": "text/plain",
      "value": "Testing from foia subdomain"
    }]
  }' \
  -s -w "Status: %{http_code}\n" -o /tmp/test2.json

echo ""
cat /tmp/test2.json
echo ""
echo ""

# Test 3: Authenticated domain (should work)
echo "Test 3: requests@em7571.foib-request.com (authenticated domain) ✅"
curl -X POST https://api.sendgrid.com/v3/mail/send \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{
      "to": [{"email": "shadewofficial@gmail.com"}],
      "subject": "Test from authenticated domain"
    }],
    "from": {
      "email": "requests@em7571.foib-request.com",
      "name": "FOIA Request Team"
    },
    "content": [{
      "type": "text/plain",
      "value": "Testing from authenticated domain"
    }]
  }' \
  -s -w "Status: %{http_code}\n" -o /tmp/test3.json

echo ""
cat /tmp/test3.json
echo ""

