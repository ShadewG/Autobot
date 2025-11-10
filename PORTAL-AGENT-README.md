# 🤖 Portal Agent - Quick Start Guide

## Setup (First Time Only)

Create a `.env` file in the project root with your API key:

```bash
# .env
ANTHROPIC_API_KEY=your-anthropic-api-key-here
REQUESTS_INBOX=requests@foib-request.com
```

**Security Note:** The `.env` file is in `.gitignore` and won't be committed to git.

---

## Running the Test

### Option 1: Double-Click (Easiest)
1. Navigate to the project folder in Finder
2. **Double-click** `run-portal-test.command`
3. Watch the browser window open and the AI work!
4. Screenshots will automatically open when complete

### Option 2: Terminal
```bash
cd "/Users/samuelhylton/Documents/gits/Autobot MVP"
./run-portal-test.command
```

### Option 3: Manual
```bash
cd "/Users/samuelhylton/Documents/gits/Autobot MVP"
export ANTHROPIC_API_KEY="your-anthropic-api-key-here"
export REQUESTS_INBOX="requests@foib-request.com"
node test-portal-agent.js "https://colliercountyshofl.govqa.us/WEBAPP/_rs/(S(40bmt2z4fqa2vj4qjeprylkk))/RequestLogin.aspx?sSessionID=&rqst=4&target=..."
```

---

## What Happens

1. ✅ Browser window opens (visible, not headless)
2. 🤖 AI agent navigates to Collier County portal
3. 👁️ Agent analyzes the page using vision (screenshot-based)
4. 🎯 Agent autonomously decides actions (click, type, etc.)
5. 📝 Agent fills out FOIA request form with case data
6. 🛑 Agent stops before final submit (dry-run mode)
7. 📸 Screenshots and logs are saved

---

## Output Files

After completion, find your results here:

### Screenshots (Step-by-Step)
```
portal-screenshots/
├── step-01-click.png       ← AI clicking "Create Account"
├── step-02-type.png        ← AI entering email
├── step-03-type.png        ← AI entering name
├── step-04-select.png      ← AI selecting dropdown
└── ...
```

**Location:** `./portal-screenshots/`

### Final Screenshot
```
portal-agent-result.png     ← Full-page capture of completed form
```

**Location:** `./portal-agent-result.png`

### Detailed JSON Log
```json
{
  "success": true,
  "stepsCompleted": 15,
  "finalUrl": "https://...",
  "stepLog": [...]
}
```

**Location:** `./portal-agent-log.json`

---

## Test Case Data

The test uses **Michael Allen Pritchard** case:
- **Subject:** Michael Allen Pritchard
- **Agency:** Collier County Sheriff's Office
- **State:** Florida
- **Records Requested:** Body camera, dashcam, 911 calls, incident reports, arrest reports, booking photos
- **Portal:** Collier County GovQA Portal

---

## Troubleshooting

### "Node.js is not installed"
Install Node.js from: https://nodejs.org/

### "Permission denied"
Make the script executable:
```bash
chmod +x run-portal-test.command
```

### "Browser doesn't open"
Check that Playwright is installed:
```bash
npx playwright install chromium
```

### "Agent gets stuck"
- Check the console output for vision model responses
- Review step-by-step screenshots to see where it stopped
- Increase `maxSteps` in `test-portal-agent.js` if needed

### "API key invalid"
The key is hardcoded in the script. If it expires, update:
```bash
export ANTHROPIC_API_KEY="your-new-key-here"
```

---

## Viewing Results

### Open screenshots folder
```bash
open portal-screenshots/
```

### View final result
```bash
open portal-agent-result.png
```

### Read JSON log
```bash
cat portal-agent-log.json | jq .
```

### Create animated GIF
```bash
brew install imagemagick
convert -delay 100 portal-screenshots/*.png portal-agent-journey.gif
open portal-agent-journey.gif
```

---

## Customizing the Test

### Use a different portal
Edit `run-portal-test.command` and change the `PORTAL_URL` variable.

### Use different case data
Edit `test-portal-agent.js` and modify the `testCase` object.

### Increase max steps
Edit `test-portal-agent.js` line 43:
```javascript
maxSteps: 50,  // Increase from 20
```

### Disable dry-run (actually submit)
⚠️ **Warning:** This will submit a real FOIA request!

Edit `test-portal-agent.js` line 44:
```javascript
dryRun: false,  // Change from true
```

---

## How the Agent Works

The agent uses **Anthropic's Computer Use** (Claude with vision):

1. **Vision Analysis:** Takes screenshot of current page
2. **Reasoning:** Claude analyzes what it sees
3. **Decision:** Chooses next action (click, type, scroll, etc.)
4. **Execution:** Playwright executes the action
5. **Loop:** Repeats until task is complete

**Actions Available:**
- `click` - Click buttons/links
- `type` - Fill text fields
- `select` - Choose dropdown options
- `scroll` - Scroll page
- `wait` - Wait for elements
- `wait_for_email_code` - Fetch OTP from database
- `complete` - Mark task finished
- `error` - Report failure

---

## Support

If you encounter issues, check:
1. Console output for error messages
2. Step-by-step screenshots to see agent's perspective
3. JSON log for detailed action trace
4. Railway logs if database queries fail

**Happy automating!** 🚀
