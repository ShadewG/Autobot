# 🌿 Git Branching Strategy

## Branch Overview

### 📧 **main** (Production - Email Only)
**Purpose:** Stable, production-ready email automation
**Deployed to:** Railway production environment
**Contains:**
- ✅ Email sending/receiving via SendGrid
- ✅ AI-powered FOIA request generation
- ✅ Auto-reply and follow-up system
- ✅ Notion integration
- ✅ Email threading and tracking
- ✅ Test dashboard for monitoring
- ❌ NO portal automation (browser automation removed)

**Use this branch when:**
- Deploying to production
- Making bug fixes to email system
- Adding features to email workflow
- Creating releases

---

### 🧪 **staging** (Testing - All Features)
**Purpose:** Development and testing of new features
**Contains:**
- ✅ Everything from main branch
- ✅ **Portal automation** (Playwright + Claude Computer Use)
- ✅ Browser-based form filling
- ✅ Account creation automation
- ✅ OTP code handling
- ✅ Screenshot debugging
- ✅ Experimental features

**Use this branch when:**
- Testing portal automation
- Developing new features
- Experimenting with AI agents
- Running tests that need browser automation

---

## Workflow

### 🔄 Normal Development Flow

```bash
# 1. Start from staging for new features
git checkout staging
git pull origin staging

# 2. Create feature branch
git checkout -b feature/your-feature-name

# 3. Make changes and commit
git add .
git commit -m "Add feature X"

# 4. Push feature branch
git push -u origin feature/your-feature-name

# 5. Test on staging
git checkout staging
git merge feature/your-feature-name
git push origin staging

# 6. If stable, merge to main (email features only)
git checkout main
git pull origin main
git merge feature/your-feature-name  # Only if email-related
git push origin main
```

---

### 🚀 Deploying Email Features to Production

```bash
# 1. Ensure feature is tested on staging
git checkout staging
# ... test thoroughly ...

# 2. Switch to main
git checkout main
git pull origin main

# 3. Cherry-pick email-only commits (avoid portal code)
git cherry-pick <commit-hash>

# OR merge entire feature if email-only
git merge feature/email-feature

# 4. Push to production
git push origin main
```

---

### 🧪 Testing Portal Features

```bash
# 1. Switch to staging
git checkout staging
git pull origin staging

# 2. Run portal tests
./run-portal-test.command

# 3. View screenshots
open portal-screenshots/

# 4. When working, commit
git add .
git commit -m "Improve portal navigation"
git push origin staging
```

---

## Branch Protection Rules (Recommended)

### **main** branch:
- ✅ Require pull request reviews
- ✅ Require status checks to pass
- ✅ Require branches to be up to date
- ✅ No force pushes (except by admins)
- ⚠️  Only email-related code allowed

### **staging** branch:
- ⚡ More permissive
- ✅ Allow direct pushes for quick testing
- ✅ Can force push if needed
- ✅ All experimental code allowed

---

## File Differences

### Files ONLY in staging branch:
```
agentkit/
├── email-helper.js          # OTP code fetching
├── portal-agent-kit.js      # Portal navigation tools

services/
├── portal-agent-service.js  # Portal automation service

test-portal-agent.js          # Portal test script
run-portal-test.command       # One-click portal test runner
PORTAL-AGENT-README.md        # Portal documentation
```

### Files in BOTH branches:
```
services/
├── sendgrid-service.js       # Email sending
├── ai-service.js             # AI generation
├── foia-case-agent.js        # Email agent
├── notion-service.js         # Notion integration

routes/
├── test.js                   # Test endpoints
├── webhook.js                # SendGrid webhooks

public/
├── test-dashboard.html       # Monitoring dashboard
```

---

## Quick Reference

| Task | Branch | Command |
|------|--------|---------|
| Fix email bug | `main` | `git checkout main` |
| Test new email feature | `staging` → `main` | Cherry-pick when stable |
| Add portal automation | `staging` | `git checkout staging` |
| Deploy to production | `main` | `git push origin main` |
| Run portal tests | `staging` | `./run-portal-test.command` |

---

## Railway Deployment

### Production (main branch):
```bash
# Railway automatically deploys main branch
git push origin main
# → Deploys to: sincere-strength-production.up.railway.app
```

### Staging (staging branch):
**Option 1:** Create separate Railway project for staging
**Option 2:** Use Railway PR environments

---

## Emergency Rollback

### If main breaks:
```bash
# Find last working commit
git log --oneline

# Reset to that commit
git reset --hard <commit-hash>

# Force push (use with caution!)
git push --force-with-lease origin main
```

### If staging breaks:
```bash
# Just reset to main
git checkout staging
git reset --hard main
git push --force origin staging
```

---

## Best Practices

1. **✅ DO:**
   - Test on staging before merging to main
   - Keep main stable and production-ready
   - Use feature branches for big changes
   - Write clear commit messages
   - Tag releases on main

2. **❌ DON'T:**
   - Merge portal code to main
   - Force push to main without backup
   - Commit API keys or secrets
   - Test in production (use staging!)

---

## Current State

**Last sync:** Nov 10, 2025

**main branch:**
- Commit: `19736cf` "Add Notion page launch form to test dashboard"
- Email automation fully working
- No portal code
- Production-ready

**staging branch:**
- Commit: `81b5ad4` "Fix: Add fallback click strategies for robust element detection"
- Portal automation working
- Claude Sonnet 4.5 integrated
- Screenshot debugging enabled

---

**Questions?** Check commit history:
```bash
git log --oneline --graph --all
```
