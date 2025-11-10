# Portal Automation - Two Versions

This project includes **two versions** of the portal automation agent:

## 1. Local Playwright Version

**Files:**
- `services/portal-agent-service.js`
- `test-portal-agent.js`
- `run-portal-test.command`

**How it works:**
- ✅ Uses local Playwright (browser automation on your machine)
- 👀 You can **watch the browser** work in real-time (headless: false)
- 📦 Requires Playwright browsers to be installed (`npx playwright install chromium`)
- 🖥️ Runs on your local machine

**Pros:**
- Visual feedback (you see the browser)
- No cloud API costs beyond Anthropic
- Full control over browser environment

**Cons:**
- Requires local Playwright setup
- Browser can be flaky on some systems
- Needs local resources (CPU, memory)

**Usage:**
```bash
# One-click run:
./run-portal-test.command

# Or manually:
node test-portal-agent.js "https://portal-url-here.com"
```

---

## 2. Hyperbrowser Cloud Version

**Files:**
- `services/portal-agent-service-hyperbrowser.js`
- `test-portal-hyperbrowser.js`
- `run-portal-hyperbrowser.command`

**How it works:**
- ☁️ Uses Hyperbrowser (cloud browser service)
- 🌐 Browser runs remotely in the cloud
- 📸 You get screenshots of each step (no live browser view)
- 🔑 Requires Hyperbrowser API key

**Pros:**
- More reliable (no local browser issues)
- No local browser installation needed
- Scales better (can run multiple sessions)
- Built-in stealth features & CAPTCHA solving
- Sub-second browser launch

**Cons:**
- Costs money (credit-based pricing: 1 credit = $0.001)
- Can't watch browser in real-time
- Requires internet connection
- Depends on third-party service

**Usage:**
```bash
# One-click run:
./run-portal-hyperbrowser.command

# Or manually:
node test-portal-hyperbrowser.js "https://portal-url-here.com"
```

---

## Environment Variables

Add to your `.env` file:

```bash
# Required for both versions
ANTHROPIC_API_KEY=sk-ant-api03-...
REQUESTS_INBOX=requests@foib-request.com

# Required ONLY for Hyperbrowser version
HYPERBROWSER_API_KEY=hb_...
```

---

## Installation

### For Local Playwright Version:
```bash
npm install
npx playwright install chromium
```

### For Hyperbrowser Version:
```bash
npm install @hyperbrowser/sdk playwright-core
```

---

## Which One Should You Use?

### Use **Local Playwright** if:
- 🐛 You want to debug and watch the browser work
- 💰 You want to avoid cloud service costs
- 🖥️ You have a reliable local environment
- 🎓 You're developing/testing locally

### Use **Hyperbrowser** if:
- ⚡ You need reliability and speed
- ☁️ You want to run in production/cloud
- 🔄 You need to scale (multiple sessions)
- 🚫 Local Playwright is causing issues
- 🤖 You want built-in anti-detection features

---

## Screenshots & Logs

Both versions save:
- 📸 Step-by-step screenshots
- 📋 Final screenshot
- 📝 Detailed JSON log

**Local Playwright:**
- `./portal-screenshots/`
- `./portal-agent-result.png`
- `./portal-agent-log.json`

**Hyperbrowser:**
- `./portal-screenshots-hyperbrowser/`
- `./portal-agent-result-hyperbrowser.png`
- `./portal-agent-log-hyperbrowser.json`

---

## Current Model

Both versions use **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for:
- ⚡ Fast responses (sub-second)
- 💰 Low cost (~80% cheaper than Sonnet)
- 🎯 Good enough for form filling

If Haiku struggles with complex portals, you can upgrade to **Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`) in the service files.

---

## Test Case

Both versions test with the **Michael Allen Pritchard case**:
- Florida Man Murder Case
- Collier County Sheriff's Office
- Requesting: body cam, incident reports, 911 calls, etc.

Portal URL: Collier County GovQA Portal (hardcoded in run scripts)

---

## Troubleshooting

### Local Playwright Issues:
- Run `npx playwright install chromium`
- Check browser compatibility
- Try headless: true if visible browser fails

### Hyperbrowser Issues:
- Verify API key is correct
- Check Hyperbrowser dashboard for session status
- Review error screenshots if test fails
- Check credit balance

---

## Contributing

When modifying portal automation:
1. Test both versions
2. Keep them in sync (same logic, different browser source)
3. Update screenshots in both folders
4. Document any API changes
