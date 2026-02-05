# Prompt Tuning Test Plan

## Executive Summary

This document defines the complete test strategy for validating AI prompt changes. Testing occurs at two levels:

1. **Prompt Simulation (Local)** - Fast, no external dependencies, validates prompt logic
2. **API E2E (Staging)** - Full integration test through LangGraph orchestration

Both test suites must pass before deploying prompt changes to production.

---

## Test Artifacts

| File | Purpose |
|------|---------|
| `tests/fixtures/inbound/golden-fixtures.json` | 19 golden test cases |
| `scripts/test-prompt-suite.js` | Local prompt simulation runner |
| `tests/golden-runner.js` | Full E2E runner with validation |
| `tests/e2e/api-prompt-e2e.test.js` | API E2E test suite (to create) |
| `tests/reports/prompt-simulation-report.json` | Local test results |
| `tests/reports/api-e2e-report.json` | E2E test results |

---

## Part 1: Prompt Simulation (Local, No API)

### Overview

Tests AI prompt functions directly without HTTP calls or database writes. Fast iteration loop for prompt tuning.

### Command

```bash
# Run all fixtures
node scripts/test-prompt-suite.js

# Run specific fixture
node scripts/test-prompt-suite.js --fixture=portal

# Run category
node scripts/test-prompt-suite.js --category=no_response

# Verbose output
node scripts/test-prompt-suite.js --verbose

# Dry run (validate fixtures only, no AI calls)
node scripts/test-prompt-suite.js --dry-run
```

### Test Flow

```
For each of 19 fixtures:
  1. Load fixture (message, case_data, expected)
  2. Call aiService.analyzeResponse(message, case_data)
  3. Validate JSON structure
  4. Validate against expected values
  5. Check invariants (portal→no response, etc.)
  6. If requires_response=true:
     - Call appropriate generator (generateAutoReply, generateFeeAcceptance, etc.)
     - Validate draft content
     - Check word limits
     - Check forbidden phrases
  7. Record pass/fail
```

### Pass Standards (All Must Be 100%)

| Standard | Description | Target |
|----------|-------------|--------|
| JSON Valid | All analyzeResponse() returns parse as valid JSON with required fields | 100% |
| Portal → No Response | All `portal_redirect` intents have `requires_response=false` | 100% |
| No Email Validity Arguments | Zero drafts contain "email is valid", "law requires", etc. when portal exists | 100% |
| No Statute Citations | Zero drafts contain "pursuant to", "ILCS", "Gov Code" on no-response intents | 100% |

### Invariants (Hard Rules)

These invariants are checked for EVERY fixture. A single violation fails the test.

#### 1. No-Response Intents Must Not Generate Drafts

```javascript
NO_RESPONSE_INTENTS = [
  'portal_redirect',
  'acknowledgment',
  'records_ready',
  'delivery',
  'partial_delivery',
  'wrong_agency'
]

// For each: requires_response MUST be false
// If draft generated: TEST FAILS
```

#### 2. Portal Redirect Handling

```javascript
// When intent = 'portal_redirect':
assert(analysis.requires_response === false);
assert(analysis.portal_url !== null);  // Must extract URL
assert(draft === null || draft.body_text === null);  // No email

// Draft must NOT contain:
PORTAL_FORBIDDEN = [
  'email is valid',
  'treat this email',
  'law requires',
  'statute requires',
  'legally required to accept',
  'must process',
  'obligated to process'
]
```

#### 3. Word Limits by Intent

| Intent | Max Words |
|--------|-----------|
| more_info_needed | 100 |
| question | 100 |
| fee_request | 150 |
| denial | 200 |
| hostile | 150 |
| followup_1 | 120 |
| followup_2 | 150 |
| followup_3 | 180 |

#### 4. No Statute Citations on Simple Responses

```javascript
// For acknowledgment, records_ready, delivery, partial_delivery:
// Draft (if any) must NOT contain:
NO_STATUTE_PHRASES = [
  'pursuant to',
  'per statute',
  'under statute',
  'ILCS',
  'Gov Code',
  'FOIL',
  '§'
]
```

### Fixture Categories

#### Category: `no_response` (6 fixtures)

| Fixture ID | Intent | Expected |
|------------|--------|----------|
| `portal_redirect_simple` | portal_redirect | requires_response=false, extract URL |
| `portal_redirect_nextrequest` | portal_redirect | requires_response=false, extract NextRequest URL |
| `acknowledgment_simple` | acknowledgment | requires_response=false |
| `records_ready_download` | records_ready | requires_response=false |
| `delivery_complete` | delivery | requires_response=false |
| `partial_delivery_more_coming` | partial_delivery | requires_response=false |

#### Category: `respond_required` (4 fixtures)

| Fixture ID | Intent | Expected |
|------------|--------|----------|
| `more_info_needed_date` | more_info_needed | requires_response=true, draft ≤100 words |
| `direct_question_scope` | question | requires_response=true, draft ≤100 words |
| `fee_request_low` | fee_request | requires_response=true, brief acceptance |
| `fee_request_high` | fee_request | requires_response=true, negotiate or human review |

#### Category: `denials` (4 fixtures)

| Fixture ID | Intent | Expected |
|------------|--------|----------|
| `denial_weak_no_records` | denial | Accept denial (no evidence to challenge) |
| `denial_strong_exemption` | denial | Generate rebuttal, offer redactions |
| `denial_overly_broad_portal` | portal_redirect | Detect portal, NO rebuttal |
| `denial_overly_broad_genuine` | denial | Offer narrowing, phased approach |

#### Category: `edge_cases` (2 fixtures)

| Fixture ID | Intent | Expected |
|------------|--------|----------|
| `wrong_agency_redirect` | wrong_agency | requires_response=false |
| `hostile_response` | hostile | Escalate, requires_response=true |

#### Category: `followup` (3 fixtures)

| Fixture ID | Attempt | Expected |
|------------|---------|----------|
| `followup_attempt_1` | 1 | ≤120 words, NO legal citations |
| `followup_attempt_2` | 2 | ≤150 words, may cite deadline |
| `followup_attempt_3` | 3 | ≤180 words, may cite statute |

### Expected Output

```
================================================================================
PROMPT SIMULATION TEST RESULTS
================================================================================

### no_response (6/6)
  ✅ portal_redirect_simple (1234ms)
  ✅ portal_redirect_nextrequest (1156ms)
  ✅ acknowledgment_simple (1089ms)
  ✅ records_ready_download (1201ms)
  ✅ delivery_complete (1145ms)
  ✅ partial_delivery_more_coming (1178ms)

### respond_required (4/4)
  ✅ more_info_needed_date (2345ms)
  ✅ direct_question_scope (2123ms)
  ✅ fee_request_low (2456ms)
  ✅ fee_request_high (2567ms)

### denials (4/4)
  ✅ denial_weak_no_records (2890ms)
  ✅ denial_strong_exemption (3012ms)
  ✅ denial_overly_broad_portal (1234ms)
  ✅ denial_overly_broad_genuine (3145ms)

### edge_cases (2/2)
  ✅ wrong_agency_redirect (1123ms)
  ✅ hostile_response (2678ms)

### followup (3/3)
  ✅ followup_attempt_1 (1890ms)
  ✅ followup_attempt_2 (1956ms)
  ✅ followup_attempt_3 (2034ms)

================================================================================
SUMMARY
================================================================================
Total:    19
Passed:   19 (100%)
Failed:   0
Warnings: 2
Invariant Violations: 0

--- PASS STANDARDS ---
JSON Valid:           100% (target: 100%)
Portal → No Response: 100% (target: 100%)
No Email Validity:    100% (target: 100%)
No Statute Citations: 100% (target: 100%)

✅ ALL PASS STANDARDS MET
```

---

## Part 2: API E2E (Staging)

### Overview

Full integration test through the API → LangGraph → Database pipeline. Tests that the orchestration layer correctly respects `requires_response` from analysis.

### Prerequisites

- Staging database with test cases
- API server running (`npm run dev` or staging environment)
- Test user authentication (if required)

### Command

```bash
# Run E2E tests
npm run test:e2e:prompts

# Or directly
node tests/e2e/api-prompt-e2e.test.js
```

### Test Flow

```
For each of 19 fixtures:
  1. Create test case in DB (or use existing)
  2. POST /api/cases/:id/ingest-email
     - Body: { subject, body_text, from_address, message_type: 'inbound' }
  3. POST /api/cases/:id/run-inbound
     - Triggers LangGraph execution
  4. Poll GET /api/agent-runs/:runId (or /api/cases/:id/agent-runs)
     - Wait for status != 'running'
     - Timeout after 60 seconds
  5. Assert final state:
     - For no_response intents: NO proposal created
     - For respond_required intents: proposal created with correct action_type
     - Case status updated appropriately
  6. Record pass/fail
```

### API Endpoints Used

#### 1. Ingest Email

```http
POST /api/cases/:caseId/ingest-email
Content-Type: application/json

{
  "subject": "Re: FOIA Request #12345",
  "body_text": "Please submit your request through our portal...",
  "from_address": "records@agency.gov",
  "message_type": "inbound"
}

Response:
{
  "success": true,
  "messageId": 456
}
```

#### 2. Run Inbound Handler

```http
POST /api/cases/:caseId/run-inbound
Content-Type: application/json

{
  "messageId": 456,
  "autopilotMode": "SUPERVISED"
}

Response:
{
  "success": true,
  "runId": "run_abc123",
  "status": "started"
}
```

#### 3. Poll Agent Run Status

```http
GET /api/agent-runs/:runId

Response:
{
  "id": "run_abc123",
  "case_id": 123,
  "status": "completed",  // running | completed | failed | interrupted
  "started_at": "2025-01-22T10:00:00Z",
  "ended_at": "2025-01-22T10:00:05Z",
  "proposal_id": null,  // null if no response needed
  "metadata": {
    "classification": "PORTAL_REDIRECT",
    "requires_response": false,
    "suggested_action": "use_portal"
  }
}
```

#### 4. Get Proposals (if any)

```http
GET /api/cases/:caseId/proposals

Response:
{
  "proposals": [
    {
      "id": 789,
      "case_id": 123,
      "action_type": "SEND_CLARIFICATION",
      "status": "pending_approval",
      "subject": "Re: ...",
      "body_text": "...",
      "created_at": "..."
    }
  ]
}
```

### E2E Assertions

#### For `no_response` Fixtures

```javascript
// After run completes:
assert(run.status === 'completed');
assert(run.proposal_id === null);  // NO proposal created

// Case state:
if (fixture.expected.suggested_action === 'use_portal') {
  assert(case.portal_url !== null);  // URL saved
}
if (fixture.expected.suggested_action === 'download') {
  assert(case.status === 'completed');
}
```

#### For `respond_required` Fixtures

```javascript
// After run completes:
assert(run.status === 'interrupted' || run.status === 'completed');
assert(run.proposal_id !== null);  // Proposal created

// Proposal:
const proposal = await getProposal(run.proposal_id);
assert(proposal.action_type === fixture.expected.action_type);
assert(proposal.status === 'pending_approval');

// Draft content:
assert(proposal.body_text !== null);
assert(countWords(proposal.body_text) <= fixture.expected.max_words);
```

#### For `denial` Fixtures

```javascript
// denial_overly_broad_portal: Should detect portal, NO proposal
if (fixture.fixture_id === 'denial_overly_broad_portal') {
  assert(run.proposal_id === null);
  assert(case.portal_url !== null);
}

// denial_strong_exemption: Should create rebuttal proposal
if (fixture.fixture_id === 'denial_strong_exemption') {
  assert(run.proposal_id !== null);
  const proposal = await getProposal(run.proposal_id);
  assert(proposal.action_type === 'SEND_REBUTTAL');
}
```

### E2E Test Matrix

| Fixture ID | Expected Run Status | Proposal? | Case Update |
|------------|---------------------|-----------|-------------|
| portal_redirect_simple | completed | NO | portal_url set |
| portal_redirect_nextrequest | completed | NO | portal_url set |
| acknowledgment_simple | completed | NO | none |
| records_ready_download | completed | NO | status=completed |
| delivery_complete | completed | NO | status=completed |
| partial_delivery_more_coming | completed | NO | none |
| more_info_needed_date | interrupted | YES (SEND_CLARIFICATION) | none |
| direct_question_scope | interrupted | YES (SEND_CLARIFICATION) | none |
| fee_request_low | interrupted | YES (ACCEPT_FEE) | none |
| fee_request_high | interrupted | YES (NEGOTIATE_FEE) | none |
| denial_weak_no_records | completed | NO | accept denial |
| denial_strong_exemption | interrupted | YES (SEND_REBUTTAL) | none |
| denial_overly_broad_portal | completed | NO | portal_url set |
| denial_overly_broad_genuine | interrupted | YES (SEND_REBUTTAL) | none |
| wrong_agency_redirect | completed | NO | substatus=wrong_agency |
| hostile_response | interrupted | YES (ESCALATE) | pause_reason=SENSITIVE |
| followup_attempt_1 | interrupted | YES (SEND_FOLLOWUP) | none |
| followup_attempt_2 | interrupted | YES (SEND_FOLLOWUP) | none |
| followup_attempt_3 | interrupted | YES (SEND_FOLLOWUP) | none |

---

## Part 3: Test Data Setup

### Creating Test Cases

```sql
-- Create minimal test cases for each fixture category
INSERT INTO cases (
  agency_name, state, status,
  request_summary, incident_date,
  autopilot_mode, created_at
) VALUES
  ('Test Portal Agency', 'NC', 'pending', 'Portal test', '2024-01-01', 'SUPERVISED', NOW()),
  ('Test Ack Agency', 'CA', 'pending', 'Acknowledgment test', '2024-01-01', 'SUPERVISED', NOW()),
  -- ... etc
RETURNING id;
```

### Seeding Test Messages

```javascript
// In test setup
const testCases = await db.query(`
  SELECT id, agency_name FROM cases
  WHERE agency_name LIKE 'Test%'
  ORDER BY id
`);

for (const fixture of fixtures) {
  const testCase = testCases.find(c => c.agency_name.includes(fixture.category));

  await db.createMessage({
    case_id: testCase.id,
    message_type: 'inbound',
    subject: fixture.message.subject,
    body_text: fixture.message.body_text,
    from_address: fixture.message.from_address || 'test@agency.gov'
  });
}
```

---

## Part 4: CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/prompt-tests.yml
name: Prompt Tests

on:
  push:
    paths:
      - 'prompts/**'
      - 'services/ai-service.js'
      - 'langgraph/**'
  pull_request:
    paths:
      - 'prompts/**'
      - 'services/ai-service.js'
      - 'langgraph/**'

jobs:
  prompt-simulation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run prompt simulation
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: node scripts/test-prompt-suite.js

      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: prompt-simulation-report
          path: tests/reports/prompt-simulation-report.json

  api-e2e:
    runs-on: ubuntu-latest
    needs: prompt-simulation
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Run E2E tests against staging
        env:
          STAGING_API_URL: ${{ secrets.STAGING_API_URL }}
          STAGING_API_KEY: ${{ secrets.STAGING_API_KEY }}
        run: npm run test:e2e:prompts
```

### Pre-Deploy Checklist

```markdown
## Prompt Change Deployment Checklist

- [ ] All 19 fixtures pass local simulation
- [ ] Pass standards met:
  - [ ] 100% JSON valid
  - [ ] 100% portal → no response
  - [ ] 0% email validity arguments
  - [ ] 0% statute citations on no-response
- [ ] E2E tests pass on staging
- [ ] Manual spot-check of 3 sample outputs
- [ ] `docs/prompt-tuning-report.md` updated with changes
- [ ] PR approved by team lead
```

---

## Part 5: Debugging Failed Tests

### Common Failures

#### 1. "Intent mismatch"

```
❌ portal_redirect_simple
   Intent mismatch: got "denial", expected "portal_redirect"
```

**Fix**: Update `analysisSystemPrompt` to better recognize portal redirect patterns.

#### 2. "requires_response mismatch"

```
❌ acknowledgment_simple
   requires_response mismatch: got true, expected false
```

**Fix**: Check CRITICAL DECISION RULES in prompt. Ensure "ACKNOWLEDGMENT is NOT a reply event" rule is clear.

#### 3. "Draft contains forbidden phrase"

```
❌ portal_redirect_nextrequest
   INVARIANT VIOLATION: Draft contains forbidden phrase: "email is valid"
```

**Fix**:
1. Check `autoReplySystemPrompt` FORBIDDEN section
2. Check `denialRebuttalSystemPrompt` DO NOT SEND REBUTTAL IF section
3. Ensure portal detection runs before rebuttal generation

#### 4. "Word count exceeds limit"

```
❌ more_info_needed_date
   Word count 145 exceeds limit 100 for more_info_needed
```

**Fix**: Update `autoReplySystemPrompt` word limit instruction. Currently says "under 100 words for simple responses".

### Viewing Full Output

```bash
# Verbose mode shows analysis and draft content
node scripts/test-prompt-suite.js --fixture=portal --verbose
```

### Manual Testing Single Fixture

```javascript
// scripts/test-single-fixture.js
const aiService = require('../services/ai-service');
const fixture = require('../tests/fixtures/inbound/golden-fixtures.json')
  .fixtures.find(f => f.fixture_id === 'portal_redirect_simple');

async function test() {
  const analysis = await aiService.analyzeResponse(fixture.message, fixture.case_data);
  console.log('Analysis:', JSON.stringify(analysis, null, 2));

  if (analysis.requires_response) {
    const draft = await aiService.generateAutoReply(fixture.message, analysis, fixture.case_data);
    console.log('Draft:', draft?.body_text);
  }
}

test();
```

---

## Part 6: Metrics & Monitoring

### Key Metrics to Track

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `prompt.analysis.latency_ms` | Time for analyzeResponse() | >5000ms |
| `prompt.draft.latency_ms` | Time for generateAutoReply() | >8000ms |
| `prompt.json_parse_failures` | Invalid JSON from LLM | >0 |
| `prompt.invariant_violations` | Forbidden phrase detections | >0 |
| `orchestration.no_response_with_proposal` | Proposals created when requires_response=false | >0 |

### Dashboard Queries

```sql
-- No-response intents that generated proposals (bug)
SELECT
  ra.intent,
  COUNT(*) as count
FROM response_analysis ra
JOIN auto_reply_queue arq ON arq.case_id = ra.case_id
WHERE ra.intent IN ('portal_redirect', 'acknowledgment', 'records_ready', 'delivery')
  AND ra.created_at > NOW() - INTERVAL '7 days'
GROUP BY ra.intent;

-- Expected: 0 rows
```

```sql
-- Draft word counts by intent
SELECT
  ra.intent,
  AVG(array_length(regexp_split_to_array(arq.body_text, '\s+'), 1)) as avg_words,
  MAX(array_length(regexp_split_to_array(arq.body_text, '\s+'), 1)) as max_words
FROM response_analysis ra
JOIN auto_reply_queue arq ON arq.case_id = ra.case_id
WHERE ra.created_at > NOW() - INTERVAL '7 days'
GROUP BY ra.intent;
```

---

## Appendix A: Golden Fixture Schema

```json
{
  "fixture_id": "string (unique identifier)",
  "category": "no_response|respond_required|denials|edge_cases|followup",
  "description": "Human-readable description",
  "message": {
    "subject": "Email subject line",
    "body_text": "Full email body",
    "from_address": "sender@agency.gov"
  },
  "case_data": {
    "id": 123,
    "agency_name": "Test Agency",
    "state": "NC",
    "request_summary": "BWC footage...",
    "followup_count": 0
  },
  "expected": {
    "intent": "portal_redirect|acknowledgment|...",
    "requires_response": true|false,
    "suggested_action": "use_portal|download|wait|respond|...",
    "portal_url": "https://...|null",
    "fee_amount": 75|null,
    "should_draft_email": true|false,
    "action_type": "SEND_CLARIFICATION|ACCEPT_FEE|...",
    "draft_constraints": {
      "max_words": 100,
      "must_include": ["phrase1", "phrase2"],
      "must_not_include": ["forbidden1", "forbidden2"]
    }
  }
}
```

---

## Appendix B: Quick Reference

### Run Tests

```bash
# Local prompt simulation
node scripts/test-prompt-suite.js

# Full E2E with validation
node tests/golden-runner.js

# API E2E (staging)
npm run test:e2e:prompts
```

### Pass Standards

| Standard | Target |
|----------|--------|
| JSON Valid | 100% |
| Portal → No Response | 100% |
| No Email Validity Args | 100% |
| No Statute Citations | 100% |

### No-Response Intents

- portal_redirect
- acknowledgment
- records_ready
- delivery
- partial_delivery
- wrong_agency

### Respond-Required Intents

- more_info_needed
- question
- fee_request
- denial (conditional)
- hostile
