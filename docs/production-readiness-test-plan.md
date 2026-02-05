# Production Readiness Test Plan

## Executive Summary

This document defines the **go/no-go gates** for deploying the FOIA agent to production. Prompt quality is secondary to pipeline reliability - the system must first reliably process inbound messages and execute decisions.

**Critical Blockers (from prod-readiness report):**
1. `run-inbound` returning 400 for valid payloads
2. `Approve` not executing / not updating state
3. No-response intents incorrectly creating proposals

All gates must pass before production deployment.

---

## Part A: Prompt Simulation (Local)

### Current Pass Standards (Keep)

| Standard | Target | Description |
|----------|--------|-------------|
| JSON Valid | 100% | All `analyzeResponse()` returns valid JSON with required fields |
| Portal → No Response | 100% | All `portal_redirect` intents have `requires_response=false` |
| No Email Validity Args | 100% | Zero drafts contain "email is valid" when portal exists |
| No Statute Citations | 100% | Zero drafts on no-response intents contain "pursuant to", "ILCS", etc. |

### New Standards Added

#### Schema Versioning

Each fixture's `expected` block now includes `schema_version`:

```json
{
  "expected": {
    "schema_version": "2026-01-22-v1",
    "intent": "portal_redirect",
    ...
  }
}
```

**Enforcement:**
- If `schema_version` in output doesn't match fixture's expected version, test fails
- Prevents silent prompt output changes from breaking tests
- Version format: `YYYY-MM-DD-vN`

#### Multi-Intent Fixtures (5 new)

| Fixture ID | Signals Present | Expected Intent | Notes |
|------------|-----------------|-----------------|-------|
| `multi_portal_plus_fee` | Portal + Fee mention | portal_redirect | Fee mention does NOT override portal |
| `multi_portal_plus_denial_language` | Portal + "Cannot process" | portal_redirect | "Cannot process" is NOT a denial |
| `multi_partial_approval_plus_fee` | Partial delivery + Fee | partial_delivery | Needs response for fee on remainder |
| `multi_ack_plus_fee_estimate` | Acknowledgment + Fee estimate | acknowledgment | Fee ESTIMATE is not actionable |
| `multi_denial_plus_partial_release` | Partial grant + Partial deny | partial_approval | Challenge denied, accept released |

**Critical Invariant:**
```
Portal language ALWAYS takes precedence over:
- Fee mentions (use portal first, then deal with fees)
- Denial language ("cannot process email" = portal redirect, NOT denial)
- Burden claims ("too broad" + portal = portal redirect)
```

### Command

```bash
npm run test:prompts                 # Run all 24 fixtures
npm run test:prompts -- --fixture=multi  # Run multi-intent only
npm run test:prompts:verbose         # With detailed output
```

---

## Part B: API E2E (Production Readiness Gate)

This is the **hard gate** for production deployment. All tests must pass.

### B.1 Contract Tests (No 400s)

**Requirement:** Valid payloads must never return 400.

| Endpoint | Valid Payload | Expected | Actual |
|----------|---------------|----------|--------|
| `POST /api/cases/:id/ingest-email` | `{subject, body_text, from_address}` | 200/201 | MUST PASS |
| `POST /api/cases/:id/run-inbound` | `{messageId}` | 200 | MUST PASS |
| `POST /api/proposals/:id/approve` | `{}` | 200 | MUST PASS |
| `POST /api/proposals/:id/adjust` | `{instruction: "..."}` | 200 | MUST PASS |
| `POST /api/proposals/:id/dismiss` | `{}` | 200 | MUST PASS |

**Test:**
```javascript
for (const fixture of fixtures) {
  const response = await post(`/api/cases/${caseId}/ingest-email`, {
    subject: fixture.message.subject,
    body_text: fixture.message.body_text,
    from_address: fixture.message.from_address || 'test@agency.gov'
  });

  assert(response.status !== 400, `Valid payload returned 400 for ${fixture.fixture_id}`);
}
```

### B.2 Orchestration Invariants

**CRITICAL: No-response intents must NEVER create proposals.**

```sql
-- This query must return 0 rows
SELECT
  ra.intent,
  COUNT(*) as violation_count
FROM response_analysis ra
JOIN auto_reply_queue arq ON arq.case_id = ra.case_id
  AND arq.created_at > ra.created_at  -- proposal created after analysis
WHERE ra.intent IN ('portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery', 'wrong_agency')
  AND arq.status NOT IN ('cancelled', 'dismissed')
GROUP BY ra.intent;
```

**Test Matrix:**

| Intent | Proposal Created | Execution Queued | Portal Task Created | Case Status |
|--------|------------------|------------------|---------------------|-------------|
| portal_redirect | NO | NO | YES | portal_required |
| acknowledgment | NO | NO | NO | unchanged |
| records_ready | NO | NO | NO | completed |
| delivery | NO | NO | NO | completed |
| partial_delivery | NO | NO | NO | unchanged |
| wrong_agency | NO | NO | NO | substatus=wrong_agency |
| more_info_needed | YES | NO (gated) | NO | unchanged |
| fee_request | YES | NO (gated) | NO | unchanged |
| denial | YES | NO (gated) | NO | unchanged |
| hostile | YES | NO (gated) | NO | unchanged |

### B.3 Decision Flow Tests

**Approve must update state within 5 seconds.**

```javascript
async function testApproveFlow(proposalId) {
  const before = await getProposal(proposalId);
  assert(before.status === 'pending_approval');

  const startTime = Date.now();
  await post(`/api/proposals/${proposalId}/approve`);

  // Poll for completion
  const after = await pollUntil(
    () => getProposal(proposalId),
    (p) => p.status !== 'pending_approval',
    5000  // 5 second timeout
  );

  const elapsed = Date.now() - startTime;

  assert(after.status === 'approved' || after.status === 'executed',
    `Proposal status not updated: ${after.status}`);
  assert(elapsed < 5000, `Approve took too long: ${elapsed}ms`);

  // Verify execution was queued
  const execution = await getExecution(proposalId);
  assert(execution !== null, 'No execution record created');
}
```

**Test all decision flows:**

| Action | Before Status | After Status | Side Effects |
|--------|---------------|--------------|--------------|
| APPROVE | pending_approval | approved/executed | Execution queued, run resumes |
| ADJUST | pending_approval | pending_approval | Draft regenerated with instruction |
| DISMISS | pending_approval | dismissed | Run ends, no execution |
| WITHDRAW | pending_approval | cancelled | Case status = cancelled |

### B.4 Idempotency Tests

**Duplicate inbound must return 409, not create duplicates.**

```javascript
async function testIdempotency() {
  const messageId = `<idempotency-test-${Date.now()}@test>`;

  // First call - should succeed
  const first = await post(`/api/cases/${caseId}/ingest-email`, {
    message_id: messageId,
    subject: 'Test',
    body_text: 'Test body'
  });
  assert(first.status === 201);

  // Second call with same message_id - should return 409
  const second = await post(`/api/cases/${caseId}/ingest-email`, {
    message_id: messageId,
    subject: 'Test',
    body_text: 'Test body'
  });
  assert(second.status === 409, `Expected 409, got ${second.status}`);

  // Verify only one message in DB
  const messages = await getMessages(caseId);
  const matching = messages.filter(m => m.message_id === messageId);
  assert(matching.length === 1, `Expected 1 message, found ${matching.length}`);
}
```

**Scheduled followup idempotency:**
```javascript
async function testScheduledIdempotency() {
  const scheduledKey = `followup:${caseId}:1`;

  // Simulate duplicate cron triggers
  const results = await Promise.all([
    post(`/api/cases/${caseId}/trigger-followup`, { scheduled_key: scheduledKey }),
    post(`/api/cases/${caseId}/trigger-followup`, { scheduled_key: scheduledKey }),
    post(`/api/cases/${caseId}/trigger-followup`, { scheduled_key: scheduledKey })
  ]);

  // Only one should succeed (200), others should return 409
  const successes = results.filter(r => r.status === 200);
  const conflicts = results.filter(r => r.status === 409);

  assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
  assert(conflicts.length === 2, `Expected 2 conflicts, got ${conflicts.length}`);
}
```

### B.5 Timeout Tests

**Any run > 30 seconds must fail test and dump node trace.**

```javascript
async function testRunTimeout(fixture) {
  const startTime = Date.now();

  await ingestEmail(caseId, fixture);
  const { runId } = await triggerInbound(caseId);

  try {
    const run = await pollUntil(
      () => getAgentRun(runId),
      (r) => r.status !== 'running',
      30000  // 30 second hard timeout
    );

    const elapsed = Date.now() - startTime;
    assert(elapsed < 30000, `Run exceeded 30s timeout: ${elapsed}ms`);

  } catch (timeoutError) {
    // Dump node trace for debugging
    const trace = await getAgentRunNodeTrace(runId);
    console.error('RUN TIMEOUT - Node trace:', JSON.stringify(trace, null, 2));
    throw new Error(`Run ${runId} timed out after 30s. Last node: ${trace.current_node}`);
  }
}
```

### B.6 Portal Task Creation

**CRITICAL: Portal redirect must generate portal task, not just "no email".**

```javascript
async function testPortalTaskCreation(portalFixture) {
  await ingestEmail(caseId, portalFixture);
  await triggerInbound(caseId);
  await waitForRunCompletion(caseId);

  // Assert NO proposal created
  const proposals = await getProposals(caseId);
  const recentProposals = proposals.filter(p =>
    new Date(p.created_at) > new Date(Date.now() - 30000)
  );
  assert(recentProposals.length === 0, 'Proposal created for portal_redirect');

  // Assert portal task WAS created
  const portalTasks = await getPortalTasks(caseId);
  assert(portalTasks.length > 0, 'No portal task created');

  const latestTask = portalTasks[0];
  assert(latestTask.portal_url === portalFixture.expected.portal_url,
    'Portal URL not saved correctly');
  assert(latestTask.status === 'pending', 'Portal task status not pending');

  // Assert case status updated
  const caseAfter = await getCase(caseId);
  assert(caseAfter.status === 'portal_required' ||
         caseAfter.substatus === 'portal_required',
    'Case status not updated to portal_required');
}
```

---

## Part C: Follow-up Scheduler Tests

### C.1 Due Followups Create Exactly One Run

```javascript
async function testFollowupIdempotency() {
  // Setup: case with no response for 7+ days
  const caseId = await createTestCase({ daysSinceSent: 8 });

  // Simulate cron running 3 times (race condition)
  const scheduledKey = `followup:${caseId}:1`;

  const runs = await Promise.all([
    triggerScheduledFollowup(caseId, scheduledKey),
    triggerScheduledFollowup(caseId, scheduledKey),
    triggerScheduledFollowup(caseId, scheduledKey)
  ]);

  // Verify exactly one run created
  const agentRuns = await getAgentRunsByCaseId(caseId);
  assert(agentRuns.length === 1, `Expected 1 run, got ${agentRuns.length}`);
}
```

### C.2 Pause/Resume/Cancel Behavior

```javascript
async function testFollowupPauseResume() {
  const caseId = await createTestCase({ daysSinceSent: 8 });

  // Pause followups
  await post(`/api/cases/${caseId}/pause-followups`);

  // Trigger should be rejected
  const result = await triggerScheduledFollowup(caseId, `followup:${caseId}:1`);
  assert(result.status === 'skipped', 'Followup should be skipped when paused');
  assert(result.reason === 'paused', 'Reason should be "paused"');

  // Resume
  await post(`/api/cases/${caseId}/resume-followups`);

  // Trigger should work now
  const result2 = await triggerScheduledFollowup(caseId, `followup:${caseId}:1`);
  assert(result2.status === 'started', 'Followup should start after resume');
}
```

### C.3 Max Followups Reached

```javascript
async function testMaxFollowupsReached() {
  const caseId = await createTestCase({
    daysSinceSent: 30,
    followup_count: 3  // Already at max
  });

  const result = await triggerScheduledFollowup(caseId, `followup:${caseId}:4`);

  assert(result.status === 'skipped', 'Should skip when max reached');
  assert(result.reason === 'max_followups_reached', 'Reason should be max_followups_reached');

  // Verify escalation triggered instead
  const caseAfter = await getCase(caseId);
  assert(caseAfter.substatus === 'needs_escalation' ||
         caseAfter.pause_reason === 'CLOSE_ACTION',
    'Case should be flagged for escalation');
}
```

### C.4 Supervised vs Auto Mode

```javascript
async function testFollowupModes() {
  // SUPERVISED mode - creates proposal, needs approval
  const supervisedCase = await createTestCase({
    autopilot_mode: 'SUPERVISED',
    daysSinceSent: 8
  });
  await triggerScheduledFollowup(supervisedCase, `followup:${supervisedCase}:1`);
  await waitForRunCompletion(supervisedCase);

  const supervisedProposals = await getProposals(supervisedCase);
  assert(supervisedProposals.length === 1, 'SUPERVISED should create proposal');
  assert(supervisedProposals[0].status === 'pending_approval',
    'SUPERVISED proposal should need approval');

  // AUTO mode - creates execution directly (no gate)
  const autoCase = await createTestCase({
    autopilot_mode: 'AUTO',
    daysSinceSent: 8
  });
  await triggerScheduledFollowup(autoCase, `followup:${autoCase}:1`);
  await waitForRunCompletion(autoCase);

  // In AUTO mode, should either auto-execute or still gate based on risk
  const autoRun = await getLatestAgentRun(autoCase);
  assert(
    autoRun.status === 'completed' ||
    autoRun.status === 'interrupted',
    'AUTO mode should complete or gate based on risk'
  );
}
```

---

## Part D: Go/No-Go Checklist

### Pre-Flight Checks

```markdown
## Production Deployment Checklist

### A. Prompt Simulation (Local)
- [ ] All 24 fixtures pass (including 5 multi-intent)
- [ ] 100% JSON valid
- [ ] 100% portal → no response
- [ ] 100% no email validity arguments
- [ ] 100% no statute citations on no-response
- [ ] Multi-intent fixtures all pass:
  - [ ] `multi_portal_plus_fee` → portal_redirect
  - [ ] `multi_portal_plus_denial_language` → portal_redirect
  - [ ] `multi_partial_approval_plus_fee` → partial_delivery
  - [ ] `multi_ack_plus_fee_estimate` → acknowledgment
  - [ ] `multi_denial_plus_partial_release` → partial_approval

### B. API E2E (Staging)
- [ ] Zero 400s on valid payloads
- [ ] No-response intents: zero proposals created
- [ ] Portal redirects: portal_task created, case status updated
- [ ] Approve completes within 5 seconds
- [ ] Adjust regenerates draft correctly
- [ ] Dismiss ends run without execution
- [ ] Duplicate inbound returns 409
- [ ] Duplicate scheduled_key returns 409
- [ ] All runs complete within 30 seconds

### C. Follow-up Scheduler
- [ ] Due followups create exactly one run
- [ ] Paused cases skip followups
- [ ] Max reached halts escalation
- [ ] SUPERVISED creates proposals
- [ ] AUTO mode behaves as configured

### D. Manual Verification
- [ ] Spot-check 3 portal redirect emails in staging
- [ ] Spot-check 3 fee acceptance emails
- [ ] Spot-check 3 denial rebuttals
- [ ] Review Discord notifications working
```

---

## Part E: Test Commands

```bash
# Local prompt simulation
npm run test:prompts                   # All 24 fixtures
npm run test:prompts -- --category=multi_intent  # Multi-intent only

# API E2E (staging)
npm run test:e2e:prompts               # Full E2E suite

# Production readiness (all gates)
npm run test:prod-ready                # Runs all A, B, C tests

# Individual test categories
npm run test:contract                  # B.1 Contract tests
npm run test:orchestration             # B.2 Orchestration invariants
npm run test:decisions                 # B.3 Decision flows
npm run test:idempotency               # B.4 Idempotency
npm run test:timeouts                  # B.5 Timeout tests
npm run test:portal-tasks              # B.6 Portal task creation
npm run test:followup-scheduler        # C.1-C.4 Followup tests
```

---

## Part F: Monitoring Queries

### Invariant Violation Detection

```sql
-- CRITICAL: No-response intents with proposals (should be 0)
SELECT
  DATE(ra.created_at) as date,
  ra.intent,
  COUNT(*) as violation_count
FROM response_analysis ra
JOIN auto_reply_queue arq ON arq.case_id = ra.case_id
WHERE ra.intent IN ('portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery')
  AND arq.created_at > ra.created_at
  AND arq.created_at > ra.created_at - INTERVAL '5 minutes'
  AND ra.created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE(ra.created_at), ra.intent;

-- Alert: > 0 rows
```

### Portal Task Creation Rate

```sql
-- Portal redirects should create portal tasks
SELECT
  DATE(ra.created_at) as date,
  COUNT(*) as portal_redirects,
  COUNT(pt.id) as portal_tasks_created,
  ROUND(100.0 * COUNT(pt.id) / NULLIF(COUNT(*), 0), 1) as task_creation_rate
FROM response_analysis ra
LEFT JOIN portal_tasks pt ON pt.case_id = ra.case_id
  AND pt.created_at > ra.created_at
WHERE ra.intent = 'portal_redirect'
  AND ra.created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(ra.created_at);

-- Alert: task_creation_rate < 100%
```

### Approve Latency

```sql
-- Approve action latency
SELECT
  DATE(arq.updated_at) as date,
  AVG(EXTRACT(EPOCH FROM (arq.updated_at - arq.approved_at))) as avg_execution_seconds,
  MAX(EXTRACT(EPOCH FROM (arq.updated_at - arq.approved_at))) as max_execution_seconds,
  COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (arq.updated_at - arq.approved_at)) > 5) as slow_approvals
FROM auto_reply_queue arq
WHERE arq.status IN ('executed', 'approved')
  AND arq.approved_at IS NOT NULL
  AND arq.updated_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(arq.updated_at);

-- Alert: slow_approvals > 0
```

---

## Part G: Failure Modes & Recovery

### If Portal Creates Proposal (Invariant Violation)

1. **Immediate**: Pause affected case
2. **Investigate**: Check `response_analysis.full_analysis_json` for misclassification
3. **Fix**: Update prompt or classification logic
4. **Cleanup**:
   ```sql
   UPDATE auto_reply_queue
   SET status = 'dismissed',
       dismissed_reason = 'invariant_violation_portal_redirect'
   WHERE id = <proposal_id>;
   ```

### If Approve Times Out

1. **Check**: `agent_runs.current_node` for stuck location
2. **Check**: Redis queue backlog
3. **Recovery**:
   ```sql
   -- Mark run as failed
   UPDATE agent_runs
   SET status = 'failed',
       error = 'timeout_exceeded'
   WHERE id = <run_id>;

   -- Reset proposal for retry
   UPDATE auto_reply_queue
   SET status = 'pending_approval'
   WHERE id = <proposal_id>;
   ```

### If Duplicate Proposals Created

1. **Identify**: Query by `proposal_key` for duplicates
2. **Cleanup**:
   ```sql
   -- Keep oldest, dismiss duplicates
   WITH ranked AS (
     SELECT id, ROW_NUMBER() OVER (PARTITION BY proposal_key ORDER BY created_at) as rn
     FROM auto_reply_queue
     WHERE proposal_key = '<key>'
   )
   UPDATE auto_reply_queue
   SET status = 'dismissed', dismissed_reason = 'duplicate'
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
   ```

---

## Summary: Hard Gates

| Gate | Metric | Target | Blocker |
|------|--------|--------|---------|
| Contract | 400 errors on valid payloads | 0 | YES |
| Orchestration | No-response intents with proposals | 0 | YES |
| Portal Tasks | Portal redirects creating tasks | 100% | YES |
| Approve Latency | Time to execute after approve | < 5s | YES |
| Idempotency | Duplicate creates | 0 | YES |
| Run Timeout | Runs exceeding 30s | 0 | YES |
| Prompt JSON | Valid JSON from analyzeResponse | 100% | YES |
| Prompt Classification | Portal → portal_redirect | 100% | YES |

**All gates must pass for production deployment.**
