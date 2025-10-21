# Portal Automation Testing Guide

## ✅ Status: WORKING LOCALLY

The Playwright portal automation is working correctly! The test successfully:
- Launches Chrome browser
- Navigates to forms
- Analyzes and detects form fields
- Intelligently fills fields based on case data
- Finds submit buttons
- Does NOT submit (dry run mode)
- Captures before/after screenshots

## 🧪 How to Test Locally

```bash
# Test with any portal URL
node test-portal-local.js "https://example.com/foia-request"

# Test with the local test form
node test-portal-local.js "file:///Users/samuelhylton/Documents/gits/Autobot%20MVP/test-form.html"
```

## 📊 Test Results

**Test with local HTML form:**
- ✅ Found 9 form fields
- ✅ Filled 6 fields correctly:
  - Your Name → Samuel Hylton
  - Your Email → shadewofficial@gmail.com
  - Subject Name → Gavonte & Shantrell
  - Incident Date → 2024-01-15
  - Incident Location → 123 Main St, Philadelphia, PA
  - Request Description → Full formatted FOIA request text
- ✅ Found submit button
- ✅ DID NOT SUBMIT (dry run working!)
- ✅ Screenshots saved (portal-initial.png, portal-filled.png)

## 🎯 Field Mapping Logic

The automation intelligently maps form fields to case data:

| Form Field Label | Maps To |
|-----------------|---------|
| "Your Name", "Requester Name" | REQUESTER_NAME env var or "Samuel Hylton" |
| "Email" | REQUESTER_EMAIL env var or "shadewofficial@gmail.com" |
| "Phone" | REQUESTER_PHONE env var |
| "Address" | REQUESTER_ADDRESS env var |
| "Name", "Subject Name" | case.subject_name |
| "Date" | case.incident_date |
| "Location" | case.incident_location |
| "Description", "Request" | Formatted FOIA request text |

## 🚀 Next Steps

### 1. Fix SendGrid API Key (PRIORITY)
The current SendGrid API key is returning 401 Unauthorized errors.

**How to fix:**
1. Go to Railway dashboard → Autobot project
2. Click on Variables
3. Find `SENDGRID_API_KEY`
4. Verify it's a valid API key (should start with `SG.`)
5. If invalid, generate a new one from SendGrid dashboard
6. Update the value in Railway

### 2. Deploy Portal Automation to Railway

Once SendGrid is fixed, we can deploy the portal automation:

**Option A: Use Railway's Dockerfile support**
Create a `Dockerfile` that installs Chromium:

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "server.js"]
```

**Option B: Use Nixpacks with proper browser deps**
Update `nixpacks.toml`:

```toml
[phases.setup]
nixPkgs = ["nodejs_20", "chromium"]

[phases.install]
cmds = ["npm ci"]

[start]
cmd = "node server.js"
```

## 🔍 Portal URLs to Test

When ready, test with these real portals:
- Delaware County PA: https://lawenforcementrecordsrequest.delawarecountypa.gov/
- Crime Reports: https://www.crimereports.org/submit-tip
- (Add more as you find working ones)

## 📝 API Endpoints

Once deployed, you can test portals via the API:

```bash
# Test a portal without submitting
curl -X POST https://your-app.up.railway.app/api/test-portal \
  -H "Content-Type: application/json" \
  -d '{
    "portalUrl": "https://example.com/foia"
  }'

# Test with a specific case
curl -X POST https://your-app.up.railway.app/api/test-portal/123 \
  -H "Content-Type: application/json" \
  -d '{
    "portalUrl": "https://example.com/foia"
  }'
```

## 🐛 Troubleshooting

**Browser won't launch on Railway:**
- Make sure Chromium dependencies are installed
- Check Railway logs for Playwright errors
- Verify `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is not set

**Form fields not filling:**
- Check the screenshots to see what was detected
- Field labels might be different - may need to update mapping logic
- Some fields might be dynamically loaded (need to add wait logic)

**Can't find submit button:**
- Some portals might have non-standard submit buttons
- Check screenshot to see button text
- May need to add more button text patterns
