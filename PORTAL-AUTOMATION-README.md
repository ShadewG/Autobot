# Portal Automation - Four Versions

This project includes **four versions** of the portal automation agent:

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

## 4. Skyvern AI Version 🌟 **OPEN SOURCE**

**Files:**
- `services/portal-agent-service-skyvern.js`
- `test-portal-skyvern.js`
- `run-portal-skyvern.command`

**How it works:**
- 🌟 **Open-source** browser automation platform
- 🧠 Uses **LLMs + computer vision** (similar to Claude Computer Use)
- 🎯 Can be **self-hosted** (Docker/pip install) or use cloud API
- 📝 Natural language goals + structured data payload
- 🏆 **85.85% accuracy on WebVoyager benchmark**

**Pros:**
- **Open source** - can self-host for free
- **Vision-based** - doesn't rely on brittle selectors
- Works on previously unseen websites
- Natural language instructions
- Recording URLs to watch what happened
- Can use cloud API or self-host
- Very resilient to website changes

**Cons:**
- Cloud API costs money (per step)
- Self-hosting requires infrastructure
- Python-based (we use REST API from Node.js)

**Usage:**
```bash
# One-click run:
./run-portal-skyvern.command

# Or manually:
node test-portal-skyvern.js "https://portal-url-here.com"
```

**Key advantages:**
- Open source with active development
- Can be deployed on your own infrastructure
- State-of-the-art accuracy (85.85% WebVoyager)
- Vision + LLM approach (no selector maintenance)
- Cloud API available for quick start

**Get API Key:**
1. Go to https://app.skyvern.com
2. Sign up/login
3. Settings → Reveal API key
4. Add to `.env`: `SKYVERN_API_KEY=sk-...`

### Skyvern Workflow Runner (API-only test harness)

- File: `run-skyvern-workflow.js`
- Purpose: builds the `parameters` payload (`URL`, `login`, `case_info`, `personal_info`) and hits `POST https://api.skyvern.com/v1/run/workflows` so you can test the new FOIA workflow (`workflow_id wpid_461535111447599002` by default).
- Case data is pulled directly from Postgres via `database.getCaseById`.
- Portal credentials are injected automatically if a saved account exists for the domain; otherwise the `login` field is left blank as required.
- Requester contact details are hard-coded from the usual `REQUESTER_*` env vars so Skyvern always gets the same `personal_info` structure.

**Usage**
```bash
SKYVERN_API_KEY=sk-... \
SKYVERN_WORKFLOW_ID=wpid_461535111447599002 \
node run-skyvern-workflow.js <caseId> [portalUrlOverride]
```

The script logs the safe payload (credentials redacted), calls the workflow endpoint, and prints the API response. You can optionally set:

- `SKYVERN_PROXY_LOCATION` — falls back to `RESIDENTIAL`
- `SKYVERN_BROWSER_SESSION_ID` / `SKYVERN_BROWSER_ADDRESS` — pass through to reuse persistent sessions once you have them
- `SKYVERN_WORKFLOW_RUN_URL` — override base URL if you are testing against a self-hosted Skyvern instance

---

## Environment Variables

Add to your `.env` file:

```bash
# Required for all versions
REQUESTS_INBOX=requests@foib-request.com

# Required for local Playwright and Hyperbrowser versions
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required for Hyperbrowser versions
HYPERBROWSER_API_KEY=hb_...

# Required for Skyvern version
SKYVERN_API_KEY=sk-...
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

### For Skyvern Version:
```bash
npm install axios
```

Or self-host Skyvern:
```bash
pip install skyvern
skyvern quickstart
skyvern run all
# Then set SKYVERN_API_URL=http://localhost:8000/api/v1 in .env
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

### Use **Skyvern** 🌟 if:
- 🌟 You want **open-source** solution
- 🏠 You want to **self-host** for privacy/cost
- 🏆 You want **best-in-class accuracy** (85.85%)
- 🔓 You need source code access
- 🛠️ You might want to customize the agent
- 💰 You want to avoid vendor lock-in

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

**Skyvern:**
- 🎥 **Task recording URL** (in console output and log)
- 📝 Detailed JSON log: `./portal-agent-skyvern-log.json`
- 📊 Extracted data (if data_extraction_schema provided)
- 💡 No local screenshots - watch the recording in Skyvern dashboard

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

### Skyvern Issues:
- Verify SKYVERN_API_KEY is set correctly
- Check the recording URL to see what went wrong
- Review navigation_goal - be more specific
- Increase max_steps_override if needed
- Check if API quota/credits are available
- For self-hosted: ensure Skyvern service is running

---

## Contributing

When modifying portal automation:
1. Test all versions that you're modifying
2. Keep test cases consistent across versions
3. Update documentation when adding features
4. Document API changes and new requirements

## Version Comparison Matrix

| Feature | Playwright | Hyperbrowser Manual | Hyperbrowser Managed | Skyvern |
|---------|-----------|---------------------|---------------------|---------|
| **Cost** | Free | $ (cloud) | $$ (cloud+agent) | $ (cloud) or Free (self-host) |
| **Setup** | Complex | Medium | Simple | Medium |
| **Code** | Custom loop | Custom loop | Natural language | Natural language |
| **Reliability** | Medium | High | Highest | High |
| **Open Source** | ✅ | ❌ | ❌ | ✅ |
| **Self-Hostable** | ✅ | ❌ | ❌ | ✅ |
| **Live View** | ✅ | ❌ | ❌ | ❌ |
| **Recordings** | ❌ | ❌ | ✅ | ✅ |
| **Best For** | Local dev | Custom logic | Production | Open-source needs |
