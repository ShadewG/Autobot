# Portal Automation - Three Versions

This project includes **three versions** of the portal automation agent:

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

## 3. Hyperbrowser Managed Agent Version ⭐ **RECOMMENDED**

**Files:**
- `services/portal-agent-service-managed.js`
- `test-portal-managed.js`
- `run-portal-managed.command`

**How it works:**
- 🎯 Uses Hyperbrowser's **built-in Claude Computer Use agent**
- 📝 You just provide a **natural language task description**
- 🤖 Hyperbrowser handles ALL the complexity (session, actions, parsing)
- ☁️ Browser runs in the cloud
- 🎥 Get a live URL to watch the session recording

**Pros:**
- **Simplest code** - no manual agent loop!
- **Most reliable** - Hyperbrowser's proven agent logic
- **Natural language** - just describe what you want
- Built-in error recovery
- No need to manage selectors or actions
- Live session recording

**Cons:**
- Costs money (uses Hyperbrowser + Anthropic credits)
- Can't watch browser in real-time (but can watch recording)
- Depends on Hyperbrowser service

**Usage:**
```bash
# One-click run:
./run-portal-managed.command

# Or manually:
node test-portal-managed.js "https://portal-url-here.com"
```

**Example task description:**
```
Navigate to the portal, create an account if needed using
email@example.com, fill out the FOIA request form with the
provided information, and stop before submitting (dry run).
```

Hyperbrowser figures out HOW to do it - you just describe WHAT you want!

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

### For Hyperbrowser Manual Version:
```bash
npm install @hyperbrowser/sdk playwright-core
```

### For Hyperbrowser Managed Version (recommended):
```bash
npm install @hyperbrowser/sdk
```

---

## Which One Should You Use?

### Use **Hyperbrowser Managed** ⭐ if:
- 🎯 You want the **simplest, most reliable** solution
- 📝 You prefer describing tasks in natural language
- ☁️ You're okay with cloud costs
- 🚀 You want **production-ready** automation
- 🤖 You don't want to manage selectors/actions

### Use **Local Playwright** if:
- 🐛 You want to debug and watch the browser work
- 💰 You want to avoid cloud service costs
- 🖥️ You have a reliable local environment
- 🎓 You're developing/testing locally

### Use **Hyperbrowser Manual** if:
- 🔧 You need custom action logic
- 🎛️ You want fine control over each step
- 🚫 Local Playwright is causing issues
- 📸 You need step-by-step screenshots

---

## Screenshots & Logs

**Local Playwright:**
- 📸 Step-by-step screenshots: `./portal-screenshots/`
- 📋 Final screenshot: `./portal-agent-result.png`
- 📝 Detailed JSON log: `./portal-agent-log.json`

**Hyperbrowser Manual:**
- 📸 Step-by-step screenshots: `./portal-screenshots-hyperbrowser/`
- 📋 Final screenshot: `./portal-agent-result-hyperbrowser.png`
- 📝 Detailed JSON log: `./portal-agent-log-hyperbrowser.json`

**Hyperbrowser Managed:**
- 🎥 **Live session recording URL** (in console output)
- 📝 Detailed JSON log: `./portal-agent-managed-log.json`
- 💡 No local screenshots - watch the recording instead!

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

### Hyperbrowser Manual Issues:
- Verify API key is correct
- Check Hyperbrowser dashboard for session status
- Review error screenshots if test fails
- Check credit balance

### Hyperbrowser Managed Issues:
- Verify both API keys are set (Anthropic + Hyperbrowser)
- Check the live URL to see what went wrong
- Review the task description - be more specific
- Increase maxSteps if task is complex
- Try Claude Sonnet 4.5 instead of Haiku if Haiku struggles

---

## Contributing

When modifying portal automation:
1. Test both versions
2. Keep them in sync (same logic, different browser source)
3. Update screenshots in both folders
4. Document any API changes
