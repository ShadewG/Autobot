# Codex 1 — Backend: AI Pipeline, Trigger.dev Tasks, Decision Logic

**Scope**: AI decision-making, classification, Trigger.dev tasks, eval system, prompts, lessons.
**Files you own** (only edit these):

```
trigger/steps/decide-next-action.ts
trigger/steps/classify-inbound.ts
trigger/steps/research-context.ts
trigger/steps/safety-check.ts
trigger/steps/update-constraints.ts
trigger/steps/execute-action.ts
trigger/steps/draft-response.ts
trigger/steps/load-context.ts
trigger/tasks/eval-decision.ts
trigger/tasks/process-inbound.ts
trigger/tasks/process-initial-request.ts
trigger/tasks/submit-portal.ts
trigger/tasks/health-check.ts
trigger/lib/ai.ts
trigger/lib/schemas.ts
trigger/trigger.config.ts
services/decision-memory-service.js
services/adaptive-learning-service.js
services/ai-service.js
tests/eval-dedupe.test.js
```

**DO NOT edit** (shared with Codex 2):
`services/database.js`, `services/executor-adapter.js`, `routes/*`, `server.js`, `services/cron-service.js`, migration files.

---

## Tasks

### Phase 1 P0 — Decision AI Fixes (from Braintrust eval analysis)

#### Root Cause 1: ESCALATE overuse (10 failures)
- [x] Add decision prompt rule in `decide-next-action.ts`: "ESCALATE is a last resort. If the trigger message contains a clear agency request, denial, fee notice, or referral, take the corresponding action. Only ESCALATE when genuinely ambiguous or dangerous."
- [x] Add few-shot examples to decision prompt: terse denial → SEND_REBUTTAL, scope narrowing → SEND_CLARIFICATION, wrong agency with referral → RESEARCH_AGENCY, identity verification → SEND_CLARIFICATION

#### Root Cause 2: REBUTTAL vs APPEAL confusion (3 failures)
- [x] Add decision prompt rule: "When agency issues formal denial citing specific exemptions, Vaughn index, or categorical privilege withholding → SEND_APPEAL (not SEND_REBUTTAL). Rebuttals are for vague/informal denials."
- [x] Add lesson via DecisionMemoryService: "Attorney-client privilege / work product = formal denial → SEND_APPEAL"

#### Root Cause 3: Missing action types (5 failures)
- [x] Verify RESPOND_PARTIAL_APPROVAL and NEGOTIATE_FEE are in allowed actions list in `decide-next-action.ts`
- [x] If missing, add with descriptions: RESPOND_PARTIAL_APPROVAL = "acknowledge receipt, request exemption citations, ask about segregability and appeal rights"; NEGOTIATE_FEE = "request written estimate, set not-to-exceed cap"
- [x] Add prompt rule: "When agency releases some but withholds others → RESPOND_PARTIAL_APPROVAL. When fees mentioned but no dollar amount → NEGOTIATE_FEE (never ACCEPT_FEE without specific amount)."

#### Root Cause 4: No-trigger cases getting actions (7 failures)
- [x] Add prompt rule: "If no trigger message, strongly prefer DISMISS or NONE. Do not fabricate actions."
- [x] Add guard in `decide-next-action.ts`: if no trigger message AND case not actively awaiting action → default DISMISS without AI call
- [ ] Investigate Lubbock TX portal bug — why is it selected for unrelated jurisdictions

#### Root Cause 5: RESEARCH vs direct response (3 failures)
- [x] Add prompt rule: "Vague 'policy' denial without statutory authority → SEND_REBUTTAL. 'No duty to create' → RESEARCH_AGENCY first."

### Phase 1 P1

#### Prompt & Classifier Alignment
- [ ] Remove PDF bias in `classify-inbound.ts` — attachments shouldn't force `records_ready`/`delivery`
- [ ] Add explicit prompt handling for portal/system traffic (submission confirmations, release notices, password emails)
- [ ] Decide: collapse `question` + `more_info_needed`? Collapse `delivery` + `records_ready`?
- [ ] Ensure decision prompt consumes richer classifier output: `referral_contact`, exemption citations, evidence quotes
- [ ] Exclude internal synthetic messages from normal inbound classifier path
- [ ] Add prompt rule for mixed messages: fee + denial, partial release + withholding
- [ ] Add guidance for request-form/mailing-address workflows → classify as clarification, not delivery
- [ ] Add guidance: attached letters must be classified from content, not file presence

### Phase 2 P0

#### Wire up `decision_traces`
- [x] Call `createDecisionTrace` at Trigger.dev task start, `completeDecisionTrace` at end
- [x] Cover all task types: process-inbound, process-initial-request, submit-portal
- [x] Include: classification, router output, gate decision, node trace, duration

#### Capture AI model metadata
- [x] Capture `usage` and `response.modelId` from `generateObject()` response in all Trigger.dev steps
- [x] Store in `response_analysis` table (classify) and `proposals` table (decide + draft)
- [x] Requires new columns (coordinate with Sequential list for migration)

### Phase 2 P1

#### Fix DecisionMemoryService
- [x] Inject lessons into `decide-next-action.ts` (currently only injected into drafts)
- [x] Auto-learn from ADJUST: extract human instruction as reusable lesson
- [x] Auto-learn from APPROVE: reinforce pattern (action + classification + agency type → correct)
- [x] Auto-learn from portal failures: "Portal fails for [agency] → use email"
- [x] Lesson expiry: auto-deactivate lessons older than 90 days without being applied
- [x] Lesson effectiveness tracking: if lesson fires but proposal still DISMISSED → flag
- [x] Deduplicate auto-generated lessons — generalize, don't create per-case lessons

#### Dynamic Few-Shot Examples
- [x] On every APPROVE, store case context + draft as successful example
- [x] At decision time, retrieve 2-3 most similar past decisions by classification + agency type + state
- [x] At draft time, retrieve similar successful drafts as few-shot examples
- [x] Simple keyword/category matching (no vector search)

#### Kill AdaptiveLearningService
- [x] Verify `foia_strategy_outcomes` and `foia_learned_insights` tables are empty/near-empty
- [x] Remove `generateStrategicVariation()` call from `ai-service.js`
- [x] Archive service file to `.old/`

### Phase 2 P2

#### Regression Testing
- [ ] Eval suite auto-runs on deploy (CI step in trigger deploy)
- [x] Block deploy if accuracy drops below 90%
- [ ] Track eval score trend over time
