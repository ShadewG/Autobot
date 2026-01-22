# AI Prompt Tuning Analysis

## Issue Identified

**Example Bad Response:**
When agency says "please submit via our NextRequest portal", the AI drafted an argumentative response citing NC public records law and demanding they treat the email as valid.

**Problem:** If they have a portal, just use the portal. No response needed.

---

## Scenario Analysis

### Scenario 1: Portal Redirect
**Agency says:** "Please submit your request through our NextRequest portal at [link]"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Argues email is valid, cites law | NO RESPONSE - just submit via portal |
| Treats as "denial" or "overly_broad" | Classify as "portal_redirect" - action: submit via portal |

### Scenario 2: Acknowledgment
**Agency says:** "We received your request and will respond within 10 business days"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Generates thank you reply | NO RESPONSE - just wait |
| May over-communicate | Only respond if they ask a question |

### Scenario 3: Fee Quote
**Agency says:** "The cost will be $75 for these records"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Generates fee response | IF under threshold: auto-accept. IF over: human review |
| May negotiate unnecessarily | Don't negotiate small fees - just pay |

### Scenario 4: Clarification Request
**Agency says:** "Can you provide the date of the incident?"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Generates response | Respond with the information requested - brief and helpful |

### Scenario 5: Actual Denial (No Records)
**Agency says:** "No responsive records exist"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Challenges aggressively | Challenge IF we have evidence records exist, otherwise accept |

### Scenario 6: Actual Denial (Exemption)
**Agency says:** "Denied under ongoing investigation exemption"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| Requests segregable portions | Request segregable portions - this is correct |

### Scenario 7: Records Ready
**Agency says:** "Your records are ready for download at [link]"

| Current Behavior | Correct Behavior |
|-----------------|------------------|
| May generate unnecessary reply | NO RESPONSE - just download and mark complete |

---

## Classification Logic Fixes Needed

### Current `analyzeResponse` intents:
- acknowledgment
- question
- delivery
- denial
- fee_request
- more_info_needed

### Missing intents:
- **portal_redirect** - They want us to use their portal
- **records_ready** - Records available for download (different from delivery)
- **partial_delivery** - Some records provided, more coming

### Intent → Action Mapping:

| Intent | Action Required | Email Response? |
|--------|----------------|-----------------|
| portal_redirect | Submit via portal | NO |
| acknowledgment | Wait | NO |
| records_ready | Download records | NO (maybe thank you) |
| delivery | Download, mark complete | NO |
| fee_request (< threshold) | Auto-approve, pay | Brief acceptance |
| fee_request (> threshold) | Human review | Depends on decision |
| more_info_needed | Provide info | YES - brief |
| question | Answer question | YES - brief |
| denial | Evaluate rebuttal | MAYBE - depends on type |

---

## Original vs Improved Prompts

### 1. Analysis System Prompt

**ORIGINAL:**
```
Common response types:
- Acknowledgment: "We received your request, processing..."
- Fee request: "Records will cost $X"
- More info needed: "Please clarify the date/location/etc."
- Partial delivery: "Here are some records, more coming"
- Full delivery: "All records attached"
- Denial: "Request denied under exemption X" (identify subtype below)
- Question: Asking for clarification or additional details
```

**IMPROVED:**
```
Common response types:
- portal_redirect: "Please submit via our portal" - NOT a denial, just use the portal
- acknowledgment: "We received your request" - no action needed from us
- records_ready: "Records available for download" - download them, no reply needed
- fee_request: "Cost will be $X" - pay if reasonable, negotiate only if excessive
- more_info_needed: "Please clarify..." - provide the info briefly
- partial_delivery: "Here are some records" - download and wait for more
- full_delivery: "All records attached" - download and close case
- denial: "Denied under exemption X" - evaluate for rebuttal
- question: Agency asking us something - answer briefly

CRITICAL: "portal_redirect" is NOT a denial. Do not classify portal instructions as denials.
CRITICAL: Most responses do NOT require a reply from us. Only reply when:
1. They ask us a direct question
2. They request clarification/info
3. We're accepting/negotiating fees
4. We're challenging a wrongful denial
```

---

### 2. Auto-Reply Decision Logic

**ORIGINAL:**
```javascript
const simpleIntents = ['acknowledgment', 'fee_request', 'more_info_needed'];
// Always generates a reply for these
```

**IMPROVED:**
```javascript
// Intents that require NO email response
const noResponseIntents = ['portal_redirect', 'acknowledgment', 'records_ready', 'delivery', 'partial_delivery'];

// Intents that require email response
const responseIntents = ['question', 'more_info_needed'];

// Intents that require conditional response
const conditionalIntents = ['fee_request', 'denial'];
// fee_request: Only respond if accepting or negotiating
// denial: Only respond if challenging (not all denials warrant rebuttal)
```

---

### 3. Denial Rebuttal Logic

**ORIGINAL:** Always generates aggressive rebuttal for any denial

**IMPROVED:** Evaluate if rebuttal makes sense

```
BEFORE generating a denial rebuttal, evaluate:

1. Is this actually a denial, or just a redirect/process issue?
   - "Use our portal" = NOT a denial, just submit there
   - "Wrong agency" = NOT a denial, find correct agency
   - "Need more info" = NOT a denial, provide info

2. Is the denial worth fighting?
   - "No records exist" + we have no evidence they do = Accept it
   - "No records exist" + police report mentions BWC = Challenge
   - "Records destroyed" + within retention period = Challenge
   - "Records destroyed" + past retention period = Accept it

3. Is there a simpler path?
   - Can we narrow the request instead of arguing?
   - Can we use their portal instead of email?
   - Can we pay a small fee instead of fighting it?

PRINCIPLE: Don't fight battles that don't need fighting.
Save aggressive tactics for actual wrongful denials.
```

---

### 4. Portal Redirect Handling

**NEW CLASSIFICATION:**
```
portal_redirect: Agency directs us to use their online portal for submissions.

INDICATORS:
- Mentions "portal", "NextRequest", "GovQA", "JustFOIA", "online system"
- Provides a URL for submission
- Says "please submit through" or "use our online portal"

ACTION:
- Mark case for portal submission
- Update agency record with portal URL
- Do NOT send email response
- Do NOT treat as denial

This is standard procedure for many agencies. Comply without argument.
```

---

### 5. Response Handling System Prompt

**ORIGINAL:**
```
autoReplySystemPrompt: `You are writing email responses on behalf of Samuel Hylton...

RESPONSE PRINCIPLES:
1. If they ask for clarification: Provide it clearly...
2. If they mention fees: ...
3. If they acknowledge receipt: Thank them...
```

**IMPROVED:**
```
autoReplySystemPrompt: `You are writing email responses on behalf of Samuel Hylton...

FIRST: Determine if a response is even needed.

DO NOT RESPOND TO:
- Portal redirects ("use our NextRequest portal") - just use the portal
- Simple acknowledgments ("we received your request") - just wait
- Records ready notifications ("download at this link") - just download
- Delivery confirmations - just download and close

ONLY RESPOND WHEN:
- They ask a direct question we need to answer
- They request specific information from us
- We need to accept/negotiate fees (above auto-approve threshold)
- We're challenging a wrongful denial (rare - most denials aren't worth fighting)

RESPONSE PRINCIPLES (when response IS needed):
1. Be brief - under 100 words for simple responses
2. Answer exactly what they asked - no extra information
3. Don't be overly formal or legalistic
4. Don't cite laws unless actually necessary
5. Don't argue unless there's something worth arguing about

WHAT TO AVOID:
- Responding when no response is needed
- Arguing about portal submissions (just use the portal)
- Fighting small fees (just pay them)
- Challenging valid denials
- Over-explaining or being verbose
- Citing statutes unnecessarily
```

---

### 6. Denial Strategy Updates

**ORIGINAL `overly_broad` strategy:**
Aggressive - cites segregability, demands they treat email as valid request even with portal

**IMPROVED `overly_broad` strategy:**
```
overly_broad: {
    name: "Overly Broad / Undue Burden",

    FIRST CHECK:
    - Did they offer a portal? → Use the portal, don't argue
    - Did they ask us to narrow? → Narrow the request, don't argue
    - Is this actually burdensome? → Maybe we should narrow anyway

    ONLY REBUTTAL IF:
    - We already narrowed and they still claim burden
    - They're using "burden" as excuse for simple request
    - No reasonable alternative was offered

    strategy: `
    1. If they suggested a portal or narrowing: DO THAT FIRST, don't argue
    2. If we haven't narrowed yet: Offer to narrow before citing law
    3. Only cite law if they refuse reasonable narrowed request
    4. Focus on cooperation, not confrontation

    APPROACH:
    - "Happy to narrow - here's a focused request..."
    - NOT "The law requires you to process my email..."
    `
}
```

---

### 7. New Intent: portal_redirect

Add to `denial_subtype` options in analysis:

**ORIGINAL denial_subtype options:**
- no_records
- ongoing_investigation
- privacy_exemption
- overly_broad
- excessive_fees
- wrong_agency
- retention_expired
- format_issue

**ADD:**
- portal_redirect (NOT actually a denial - reclassify intent)

**Better approach:** Add `portal_redirect` as a top-level intent, not a denial subtype:

```javascript
// In analyzeResponse prompt
1. intent: (portal_redirect | acknowledgment | question | delivery | denial | fee_request | more_info_needed | records_ready)

// If intent is portal_redirect:
- Extract portal URL
- Do NOT generate response
- Mark for portal submission
```

---

## Implementation Checklist

- [x] Update `analysisSystemPrompt` to recognize `portal_redirect` as distinct intent
- [x] Update `analyzeResponse` to extract portal URLs
- [x] Update `generateAutoReply` to return NO response for certain intents
- [x] Update denial strategies to check if simpler path exists
- [x] Add "requires_response" boolean to analysis output
- [x] Update `autoReplySystemPrompt` to emphasize when NOT to respond
- [x] Update `denialRebuttalSystemPrompt` to be less aggressive
- [x] Update `overly_broad` strategy to cooperate first
- [x] Create test script: `scripts/test-prompt-responses.js`
- [ ] Update LangGraph nodes to skip email when no response needed
- [ ] Test all scenarios with real examples

---

## Test Cases Needed

1. **Portal redirect email** → Should NOT generate response
2. **Simple acknowledgment** → Should NOT generate response
3. **Records ready notification** → Should NOT generate response
4. **Small fee quote ($25)** → Should auto-accept with brief response
5. **Large fee quote ($500)** → Should flag for human review
6. **Clarification request** → Should respond briefly with info
7. **Actual denial with exemption** → Should evaluate for rebuttal
8. **"No records" with no evidence** → Should accept, not challenge
9. **"No records" when we know they exist** → Should challenge with evidence

---

## Changes Made

### File: `prompts/response-handling-prompts.js`

**analysisSystemPrompt:**
- Added `portal_redirect` and `records_ready` as distinct intents
- Emphasized that portal_redirect is NOT a denial
- Added guidance that most messages don't need responses
- Listed when to respond vs when not to

**autoReplySystemPrompt:**
- Added "DO NOT RESPOND TO" section listing no-response scenarios
- Added "ONLY RESPOND WHEN" section
- Reduced word limit from 150 to 100
- Removed unnecessary formality guidance
- Emphasized "don't argue about portals"

### File: `prompts/denial-response-prompts.js`

**denialRebuttalSystemPrompt:**
- Added "DO NOT SEND REBUTTAL IF" section
- Changed from aggressive to cooperative-first approach
- Added "ONLY SEND REBUTTAL IF" criteria
- Reduced word limit from 250 to 200
- Changed tone guidance from "assertive" to "cooperative first"

**overly_broad strategy:**
- Added "FIRST CHECK" to avoid unnecessary rebuttals
- Removed aggressive law citation on first contact
- Added phased approach (Phase 1 = report + 911, Phase 2 = BWC)
- Simplified example rebuttal to be cooperative
- Removed argument about email vs portal validity

### File: `services/ai-service.js`

**analyzeResponse prompt:**
- Added `portal_redirect`, `records_ready`, `partial_delivery` intents
- Added `portal_url` extraction field
- Changed `requires_action` to `requires_response`
- Added guidance for each intent

**generateAutoReply:**
- Added `noResponseIntents` array for intents that never need response
- Added portal redirect detection even when misclassified as denial
- Added auto-approve logic for small fees (< $100)
- Large fees now return "needs human review" instead of auto-generating

**generateDenialRebuttal:**
- Added check for portal_url before generating rebuttal
- Added check for portal mentions in body text
- Returns "use portal" instead of arguing when portal available

### New File: `scripts/test-prompt-responses.js`

Test script with 8 scenarios:
1. Portal Redirect → No response
2. Simple Acknowledgment → No response
3. Records Ready → No response
4. Small Fee Quote → Auto-accept
5. Large Fee Quote → Human review
6. Clarification Request → Response needed
7. Actual Denial → Rebuttal needed
8. Portal Disguised as Burden → No response (use portal)
