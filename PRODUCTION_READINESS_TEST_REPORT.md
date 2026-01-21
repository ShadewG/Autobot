# Production Readiness Test Report

**Date:** 2026-01-22 (Updated)
**API:** https://sincere-strength-production.up.railway.app
**Test Script:** `tests/e2e/production-readiness-tests.js`

---

## Executive Summary

| Metric | Result |
|--------|--------|
| Total Tests | 18 |
| Passed | 9 ✅ |
| Failed | 6 ❌ |
| Skipped | 3 ⏭️ |
| Pass Rate | 60.0% |

### Production Readiness Criteria

| Criteria | Status | Notes |
|----------|--------|-------|
| 0 stuck runs (>2min) | ❌ NEEDS FIX | Resume runs getting stuck |
| Clarification completes | ✅ PASS | T7 completed in 2.9s |
| Fee thresholds work | ❌ NEEDS FIX | Action types not matching expected |
| Duplicate protection | ✅ PASS | First succeeds, second blocked |
| Records ready no proposal | ✅ PASS | Correctly produces no proposal |

---

## Progress Since Last Run

### Fixed Issues (Test Code)

1. **run-inbound 400 errors** - Fixed
   - Root cause: Test was accessing `data.message.id` but endpoint returns `data.data.message_id`
   - All 7 occurrences in test file corrected

2. **T11 not waiting for run completion** - Fixed
   - Test now waits for resume run to complete before checking status
   - Added proper waitForRunCompletion integration

3. **T12/T13 409 handling** - Fixed
   - Tests now properly skip when proposal already processed (409)
   - Better error reporting

### Created (New Endpoint)

4. **Atomic inbound-and-run endpoint** - Created
   - `POST /api/cases/:id/inbound-and-run`
   - Creates message and triggers processing in one call
   - Supports `force_new_run` option to cancel active runs
   - Includes validation error details for debugging

---

## Section 1: Smoke Tests

### T1: Initial Run Starts and Completes ✅

**Run 94:** Completed successfully
**Duration:** ~18s
**Status:** PASS

### T2: Inbound Message Processing ✅

**Status:** 409 (concurrent run blocked)
**Note:** Correctly blocked duplicate/concurrent run

### T3: Runs List Endpoint ✅

**Run Count:** 20
**Status:** PASS

---

## Section 2: Core Behavior Matrix

### T4: Fee Threshold Routing ❌

**Status:** 0/5 tests passing
**Issue:** Runs complete but action types don't match expected values

**Fee Amounts Tested:**
| Amount | Mode | Expected | Actual | Status |
|--------|------|----------|--------|--------|
| $15 | AUTO | ACCEPT_FEE + auto-exec | completed | ❌ |
| $50 | AUTO | ACCEPT_FEE + auto-exec | timeout | ❌ |
| $125 | SUPERVISED | ACCEPT_FEE + gated | completed | ❌ |
| $250 | SUPERVISED | ACCEPT_FEE + gated | completed | ❌ |
| $750 | SUPERVISED | NEGOTIATE_FEE + gated | completed | ❌ |

**Investigation Needed:**
- Check if llmStubs are being processed correctly
- Verify classification normalization (FEE_QUOTE vs fee_quote)
- Check decide-next-action routing logic

### T5: Weak Denial Rebuttal ❌

**Status:** Empty results - no proposal created

### T6: Strong Denial Gate ❌

**Status:** Empty results - no proposal created

### T7: Clarification Request ✅ (CRITICAL)

**Duration:** 2895ms
**Status:** Completed (not stuck)
**Note:** Previously broken, now working after classification normalization fix

### T8: Hostile Sentiment Gate ❌

**Status:** Empty results - no proposal created

### T9: Portal Case ⏭️

**Status:** Skipped - No portal cases available

### T10: Records Ready No Proposal ✅

**Proposal Count:** 0
**Status:** PASS - Correctly produces no proposal for RECORDS_READY

---

## Section 3: Human Decision Tests

### T11: Approve Decision ❌

**Proposal ID:** 107
**Initial Status:** PENDING_APPROVAL
**Final Status:** PENDING_APPROVAL (unchanged)
**Issue:** Resume run (92) got stuck

**Root Cause Analysis:**
- The resume run is being created and queued
- Worker picks up the job
- Graph resume hangs (no timeout in production worker)
- Proposal status never updated

### T12: Adjust Decision ✅

**Status:** 202 Accepted
**Note:** Successfully enqueued adjustment

### T13: Dismiss Decision ⏭️

**Status:** Skipped (409 - Proposal already processed)
**Note:** Expected behavior for already-actioned proposals

---

## Section 4: Idempotency Tests

### T14: Duplicate Inbound Protection ✅

**First Request:** 202 Accepted
**Second Request:** 409 Conflict
**Status:** PASS - Correctly blocked duplicate

### T15: Unique Proposal Keys ✅

**Total Keys:** 12
**Unique Keys:** 12
**Status:** PASS - 100% unique

### T16: Followup Idempotency ⏭️

**Status:** Skipped - No scheduled followups

---

## Section 5: Load Tests

### T17: Burst Test ✅

**Requests:** 10 concurrent
**Errors:** 0
**Duration:** 1101ms
**Status:** PASS

### T18: No Stuck Runs ❌

**Running:** 1
**Stuck (>2min):** 1
**Stuck Run IDs:** [92]
**Status:** FAIL

---

## Critical Issues

### 1. Resume Runs Getting Stuck (CRITICAL)

**Symptoms:**
- Resume runs (trigger_type: "resume") hang indefinitely
- Status stays "running" with no ended_at
- No metadata (node progress not tracked)
- No heartbeat

**Affected Tests:** T11 (APPROVE), T18 (stuck runs)

**Root Cause:**
- Worker timeout fix not deployed to production
- LangGraph checkpoint resume may be failing silently
- No fail-safe timeout in production worker

**Fix Required:**
1. Deploy worker timeout changes (withTimeout wrapper)
2. Deploy node progress tracking
3. Add error handling around graph resume

### 2. Fee Threshold Routing Not Working

**Symptoms:**
- Runs complete but proposals don't have expected action types
- Tests marked as "completed" but "matchesExpected: false"

**Possible Causes:**
- llmStubs not being applied correctly
- Classification not being routed properly
- Fee extraction failing

---

## What's Working Well

1. ✅ **Initial Request Graph** - Completes successfully
2. ✅ **Clarification Request** - No longer stuck (2.9s completion)
3. ✅ **Duplicate Protection** - Correctly blocks duplicates
4. ✅ **Records Ready** - Correctly produces no proposal
5. ✅ **Load Handling** - 10 concurrent requests handled
6. ✅ **Adjust Decision** - Successfully queues
7. ✅ **Runs/Proposals APIs** - All read operations working

## What Needs Work

1. ❌ **Resume Runs Hanging** - Worker timeout not deployed
2. ❌ **Fee Routing** - llmStubs or classification issue
3. ❌ **Denial/Sentiment Tests** - Empty results

---

## Deployment Checklist

Before Production:

- [ ] Deploy worker timeout fix (withTimeout wrapper)
- [ ] Deploy node progress tracking (updateAgentRunNodeProgress)
- [ ] Deploy atomic inbound-and-run endpoint
- [ ] Investigate fee routing in decide-next-action
- [ ] Create test fixtures (portal cases, followup schedules)

---

## Test File Fixes Applied

1. Fixed response property access: `data.message.id` → `data.data.message_id`
2. Added waitForRunCompletion to T11 approve test
3. Added 409 handling for T12/T13
4. Improved error reporting

---

*Generated by Production Readiness Test Suite*
*Last Run: 2026-01-21T18:56:06.311Z*
