# AI Behavior Specification

> **Purpose:** Single source of truth for every AI decision point in the Autobot pipeline.
> When you want to change behavior, edit this file and send the updated section to Claude — it will update the corresponding source files.

---

## Pipeline Overview

```
Inbound Message / Scheduled Trigger
        │
        ▼
┌─────────────────────┐
│ 1. CLASSIFY INBOUND │  ← What type of agency response is this?
│    (GPT-5.2, low)   │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 2. DECIDE ACTION    │  ← What should we do about it?
│    (GPT-5.2, medium)│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 3. RESEARCH CONTEXT │  ← What legal/contact research do we need?
│    (GPT-5.2, medium)│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 4. DRAFT RESPONSE   │  ← Generate the email text
│    (GPT-5.2, medium)│  (dispatches to 9+ sub-methods)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 5. SAFETY CHECK     │  ← Is the draft safe to send?
│    (GPT-5.2, medium)│  (regex + AI review)
└────────┬────────────┘
         │
         ▼
  Human Gate / Auto-Execute
```

---

## Models & Configuration

**Source:** `trigger/lib/ai.ts`

| Role | Model | Provider | Reasoning Effort |
|------|-------|----------|-----------------|
| Classification | `gpt-5.2-2025-12-11` | OpenAI | `low` |
| Decision | `gpt-5.2-2025-12-11` | OpenAI | `medium` |
| Draft/Research | `gpt-5.2-2025-12-11` | OpenAI | `medium` |
| Research extraction | `gpt-5.2-2025-12-11` | OpenAI | `medium` |
| Fallback (all) | `claude-sonnet-4-6` | Anthropic | N/A |
| Legacy drafts (ai-service.js) | `gpt-5.2-2025-12-11` via `callAI()` | OpenAI → Anthropic fallback | `medium` |
| State law research | `gpt-5.2-2025-12-11` + `web_search` tool | OpenAI → Anthropic fallback | `medium` |
| Agency research brief | `gpt-5.2-2025-12-11` + `web_search` tool | OpenAI → Anthropic fallback | `medium` |

**OpenAI client config:** Global 60s timeout. Web search calls have additional 45s AbortController.

---

## Step 1: Classification

**Source:** `trigger/steps/classify-inbound.ts`
**Model:** `classifyModel` (GPT-5.2, low reasoning)
**Schema:** `classificationSchema` in `trigger/lib/schemas.ts`

### System Role

The classifier prompt begins with:

```
You are an expert FOIA analyst classifying an agency response to a public records request.
```

### Full Prompt Template

The prompt is built dynamically by `buildClassificationPrompt()` and includes:

1. **Case Context** — agency name, email, state, subject, records requested, status, substatus
2. **Enriched Context** — constraints, scope items, fee quote, portal info, timing, prior proposals, research notes
3. **Thread History** — last 10 messages in chronological order with direction labels
4. **Message to Classify** — from, subject, body (truncated to 3000 chars)
5. **Attachment text** — extracted text from PDFs/documents (truncated to 4000 chars each)

### Intent Definitions

Choose the **BEST** match:

| Intent | Definition |
|--------|-----------|
| `fee_request` | Agency quotes a cost/fee for records production. Dollar amounts, invoices, cost estimates, payment instructions, or conditional authorization requests. Also includes cases where agency asks to confirm willingness to pay before sending a formal estimate. |
| `question` / `more_info_needed` | Agency asks the requester to clarify, provide ID, narrow scope, or answer a question before proceeding — without formally refusing. KEY DISTINCTION: "Please narrow to X so we CAN help" = clarification. "Request covers 50,000 pages and IS overly burdensome" = denial/overly_broad. |
| `hostile` | Agency response is threatening, abusive, or overtly adversarial beyond normal bureaucratic friction. |
| `denial` | Agency explicitly refuses to produce some or all records. Includes exemption claims, no responsive records, ongoing internal review functioning as a hold, or any indication records will be withheld. Also use when "may be withheld" citing an exemption. If denial + fee combined, classify as denial. |
| `partial_denial` | Agency releases some records but denies/withholds others citing an exemption. REQUIRES actual records being delivered. |
| `partial_approval` | Agency approves part with conditions (redactions, fee for remainder). REQUIRES actual delivery of at least some records. |
| `partial_release` / `partial_delivery` | Agency provides some records with more to follow later. |
| `portal_redirect` | Agency says to use an online portal instead of email. |
| `acknowledgment` | Agency confirms receipt, says they are working on it. No records or fees yet. CRITICAL: "matter under review" = denial (ongoing_investigation), NOT acknowledgment. Only classify as ack when the REQUEST itself is being processed. |
| `records_ready` | Records ready for pickup/download/delivery. Links, attachments, or portal notifications. |
| `delivery` | Records attached to or delivered in this message. |
| `wrong_agency` | Agency says they are not the correct custodian. |
| `other` | Does not clearly fit any category above. |

### Denial Subtypes

Only populated when intent is `denial` or `partial_denial`:

| Subtype | Definition |
|---------|-----------|
| `no_records` | No responsive records exist. If agency also offers clarification help, use `not_reasonably_described` instead. |
| `wrong_agency` | Records held by a different entity. |
| `overly_broad` | Too broad, unduly burdensome, covers too many records/pages/years. Use even when paired with a suggestion to narrow. |
| `ongoing_investigation` | Withheld due to active investigation/litigation, or internal review used to withhold. |
| `privacy_exemption` | Citing privacy of specific individuals. Requires explicit mention of individual privacy rights or PII — NOT vague "departmental policy." |
| `excessive_fees` | Denial is effectively a prohibitive cost barrier. |
| `retention_expired` | Records destroyed per retention schedule. |
| `glomar_ncnd` | Neither confirms nor denies existence of records. |
| `not_reasonably_described` | Request lacks sufficient identifiers. Use ONLY when the REQUEST is vague. NOT for internal policies or legal exemptions. |
| `no_duty_to_create` | Would need to create records to fulfill. If also emphasizes scope, prefer `overly_broad`. |
| `privilege_attorney_work_product` | Attorney-client privilege or work product. |
| `juvenile_records` | Juvenile protections. |
| `sealed_court_order` | Sealed by court order. |
| `third_party_confidential` | Third-party confidential information. |
| `records_not_yet_created` | Records don't exist yet (pending processing, future report). |
| `format_issue` | Cannot process in current format (missing form, needs resubmission via specific channel). NOT for substantive exemptions. |

### Additional Extraction Fields

| Field | Rule |
|-------|------|
| `fee_amount` | ONLY if agency is charging a processing fee for the FOIA request itself. NOT incidental dollar amounts in records content (bail, damages, salaries). |
| `portal_url` | Any URL that appears to be an online records portal. |
| `jurisdiction_level` | `federal`, `state`, or `local`. |
| `response_nature` | `substantive`, `procedural`, `administrative`, or `mixed`. |
| `exemption_citations` | Statute numbers, legal codes, exemption names cited by agency. |
| `evidence_quotes` | 1-3 short verbatim quotes (under 100 chars each) supporting classification. |
| `unanswered_question` | If agency asked a question we haven't answered. |
| `referral_contact` | For `wrong_agency`/`portal_redirect` — exact email/phone/URL provided for correct custodian. |

### Pre-Classification Rules (Hardcoded)

Before AI runs, these heuristics auto-classify:

- **Portal system confirmation emails** (from JustFOIA, NextRequest, GovQA, JotForm, SmartSheet + no-reply + confirmation language) → `ACKNOWLEDGMENT` with 0.99 confidence
- **Scheduled followup triggers** (`time_based_followup`, `SCHEDULED_FOLLOWUP`, `followup_trigger`) → `NO_RESPONSE`
- **Human review resolution** → `HUMAN_REVIEW_RESOLUTION`

### Classification Map

Raw AI intents map to system classification enums:

```
fee_request → FEE_QUOTE
question/more_info_needed → CLARIFICATION_REQUEST
hostile → HOSTILE
denial → DENIAL
partial_denial/partial_approval/partial_release → PARTIAL_APPROVAL
portal_redirect → PORTAL_REDIRECT
acknowledgment → ACKNOWLEDGMENT
records_ready/delivery → RECORDS_READY
partial_delivery → PARTIAL_DELIVERY
wrong_agency → WRONG_AGENCY
other → UNKNOWN
```

### Output Schema

**Source:** `trigger/lib/schemas.ts` — `classificationSchema`

```typescript
{
  intent: enum (see above),
  confidence_score: number (0-1),
  sentiment: "positive" | "neutral" | "negative" | "hostile",
  key_points: string[],
  extracted_deadline: string | null,
  fee_amount: number | null,
  requires_response: boolean,
  portal_url: string | null,
  suggested_action: string | null,
  reason_no_response: string | null,
  unanswered_agency_question: string | null,
  denial_subtype: enum | null,
  jurisdiction_level: "federal" | "state" | "local" | null,
  response_nature: "substantive" | "procedural" | "administrative" | "mixed" | null,
  detected_exemption_citations: string[],
  decision_evidence_quotes: string[],
  constraints_to_add: string[],
  scope_updates: { name, status, reason, confidence }[],
  fee_breakdown: { hourly_rate, estimated_hours, items, deposit_required } | null,
  referral_contact: { agency_name, email, phone, url, notes } | null,
}
```

---

## Step 2: Decision Engine

**Source:** `trigger/steps/decide-next-action.ts`
**Model:** `decisionModel` (GPT-5.2, medium reasoning)
**Schema:** `decisionSchema` in `trigger/lib/schemas.ts`
**Feature flag:** `AI_ROUTER_V2` env var (currently `true` in production)

### Action Types & Descriptions

| Action | Description | Always Requires Human |
|--------|-------------|----------------------|
| `SEND_INITIAL_REQUEST` | Send the initial FOIA request to the agency | No |
| `SEND_FOLLOWUP` | Send a follow-up message to the agency | No |
| `SEND_REBUTTAL` | Challenge the agency's denial with legal arguments | No |
| `SEND_CLARIFICATION` | Respond to agency's request for additional information | No |
| `SEND_APPEAL` | File a formal appeal | **Yes** |
| `SEND_FEE_WAIVER_REQUEST` | Request fee waiver citing public interest | **Yes** |
| `SEND_STATUS_UPDATE` | Send a status inquiry to the agency | No |
| `RESPOND_PARTIAL_APPROVAL` | Accept released records, challenge withheld portions | No |
| `ACCEPT_FEE` | Accept the quoted fee amount | No |
| `NEGOTIATE_FEE` | Propose a lower fee or narrower scope | No |
| `DECLINE_FEE` | Decline the fee and explain why | No |
| `ESCALATE` | Escalate to human review | **Yes** |
| `NONE` | No action needed — wait or acknowledge | No |
| `CLOSE_CASE` | Close the case | **Yes** |
| `WITHDRAW` | Withdraw the records request entirely | **Yes** |
| `RESEARCH_AGENCY` | Research the correct agency/custodian | **Yes** |
| `REFORMULATE_REQUEST` | Narrow or reformulate the original request | No |
| `SUBMIT_PORTAL` | Submit through the agency's web portal | No |

### Allowed Actions Logic (Hard Constraints)

`buildAllowedActions()` — AI **cannot** override these:

```
HOSTILE or UNKNOWN → [ESCALATE]
WRONG_AGENCY → [RESEARCH_AGENCY, ESCALATE]
PARTIAL_APPROVAL → [RESPOND_PARTIAL_APPROVAL, RESEARCH_AGENCY, ESCALATE]
RECORDS_READY → [NONE, CLOSE_CASE]
ACKNOWLEDGMENT → [NONE]
PARTIAL_DELIVERY → [NONE, SEND_FOLLOWUP, RESEARCH_AGENCY]
followupCount >= MAX_FOLLOWUPS → [ESCALATE]
CITIZENSHIP_REQUIRED constraint → [ESCALATE]
FEE_QUOTE → [ACCEPT_FEE, NEGOTIATE_FEE, DECLINE_FEE, SEND_FEE_WAIVER_REQUEST, SEND_REBUTTAL, ESCALATE, NONE, REFORMULATE_REQUEST, SEND_INITIAL_REQUEST]
PORTAL_REDIRECT → [SUBMIT_PORTAL, NONE, ESCALATE, RESEARCH_AGENCY]
```

Additional filters:
- Remove `SEND_INITIAL_REQUEST` when not initial request trigger
- Remove `SUBMIT_PORTAL` when no automatable portal
- Remove actions dismissed 2+ times by human

### Valid Action Chains

Primary → allowed follow-ups:

```
DECLINE_FEE → [REFORMULATE_REQUEST, SEND_INITIAL_REQUEST]
RESPOND_PARTIAL_APPROVAL → [SEND_FOLLOWUP, RESEARCH_AGENCY]
SEND_REBUTTAL → [RESEARCH_AGENCY]
SEND_FOLLOWUP → [RESEARCH_AGENCY]
SEND_CLARIFICATION → [RESEARCH_AGENCY]
REFORMULATE_REQUEST → [RESEARCH_AGENCY]
```

Chains always require human review.

### Policy Guidelines (in prompt)

#### Fee Routing

```
Fee <= $100 in AUTO mode → ACCEPT_FEE (auto-execute)
Fee $100-$500 → ACCEPT_FEE (requires human)
Fee > $500 → NEGOTIATE_FEE (requires human)
If agency also denied records → SEND_REBUTTAL first, handle fee later
If fee seems excessive → SEND_FEE_WAIVER_REQUEST (requires human)
```

**Environment variables:** `FEE_AUTO_APPROVE_MAX` (default 100), `FEE_NEGOTIATE_THRESHOLD` (default 500)

#### Denial Routing by Subtype

```
no_records (no verified custodian) → RESEARCH_AGENCY, researchLevel=deep
no_records (has verified custodian) → SEND_REBUTTAL, researchLevel=medium
wrong_agency → RESEARCH_AGENCY, researchLevel=medium
overly_broad → REFORMULATE_REQUEST
ongoing_investigation (strong) → CLOSE_CASE; (weak/medium) → SEND_REBUTTAL
privacy_exemption (strong) → CLOSE_CASE; (weak/medium) → SEND_REBUTTAL
excessive_fees → NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST
glomar_ncnd → SEND_APPEAL, researchLevel=medium
not_reasonably_described → SEND_CLARIFICATION, researchLevel=light
juvenile_records, sealed_court_order → CLOSE_CASE
third_party_confidential → SEND_REBUTTAL (accept redactions)
records_not_yet_created → SEND_STATUS_UPDATE
```

#### Unanswered Clarification

If there is an unanswered agency clarification (checked via `checkUnansweredClarification()`), strongly prefer `SEND_CLARIFICATION`.

#### Bodycam Custodian Research

If body-cam/video is a top requested record AND inbound appears limited to 911/dispatch form workflow, override to `RESEARCH_AGENCY` with `researchLevel=deep`.

#### requiresHuman Rules

```
ALWAYS require human for: CLOSE_CASE, ESCALATE, SEND_APPEAL, SEND_FEE_WAIVER_REQUEST, WITHDRAW, RESEARCH_AGENCY
Require human when confidence < 0.7
Require human in SUPERVISED mode for any email-sending action
```

### Human Directives Section

**Source:** `buildHumanDirectivesSection()` in `trigger/steps/decide-next-action.ts`

Placed at the TOP of the decision prompt with this framing:

```
## HUMAN DIRECTIVES (HIGHEST PRIORITY)
The following are decisions, instructions, and notes from the human operator.
These OVERRIDE your own analysis. If a human said to do something, do it.
Do NOT propose an action the human already rejected.
```

Includes:
1. **Human review decisions** — recent actions with instructions
2. **Phone call notes** — call outcomes and notes
3. **Previously rejected proposals** — "Do NOT repeat these action types"
4. If 3+ proposals rejected: "CRITICAL: 3+ proposals rejected. Strongly consider ESCALATE."

### Denial Strength Assessment

**Source:** `assessDenialStrength()` in `trigger/steps/decide-next-action.ts`

Scans key_points and message body for strong indicators:

**Strong indicators:** "law enforcement", "ongoing investigation", "federal investigation", "enforcement proceedings", "active prosecution", "active case", "pending case", "in court", "sealed", "court order", "cannot be provided", "nothing can be provided", "prohibited from disclosing", "confidential", "552(b)(7)", "exemption 7(a)"

**Citizen restriction pattern** (auto-strong): "available only to citizens/residents", "citizen-only", "McBurney v. Young"

Scoring: 2+ strong indicators = "strong", 1 = "medium", 0 = "weak"

### Validation (3-Attempt Self-Repair)

`validateStructureV2()` checks:
1. Confidence >= 0.5
2. Action must be in the allowed set
3. ALWAYS_GATE actions must have `requiresHuman=true`
4. Fee > $500 must use NEGOTIATE_FEE or SEND_FEE_WAIVER_REQUEST
5. Reasoning must be non-empty

If validation fails, the prompt is re-sent with: `PREVIOUS ATTEMPT FAILED: {reason}. Fix the issue and try again.`

After 3 failures → auto-ESCALATE.

### Output Schema

**Source:** `trigger/lib/schemas.ts` — `decisionSchema`

```typescript
{
  action: enum (all action types),
  reasoning: string[],
  requiresHuman: boolean,
  pauseReason: "FEE_QUOTE" | "SCOPE" | "DENIAL" | "ID_REQUIRED" | "SENSITIVE" | "CLOSE_ACTION" | null,
  confidence: number (0-1),
  adjustmentInstruction: string | null,
  researchLevel: "none" | "light" | "medium" | "deep",
  overrideMessageId: number | null,
  followUpAction: enum | null,
}
```

---

## Step 3: Research Context

**Source:** `trigger/steps/research-context.ts`
**Model:** `researchModel` (GPT-5.2, medium reasoning) for structured extraction
**Additional:** `aiService.researchStateLaws()` for state law research, `aiService.generateAgencyResearchBrief()` for deep custodian research

### Research Levels

| Level | What it does | When used |
|-------|-------------|-----------|
| `none` | Skip | Ack, records ready, partial delivery, simple followups |
| `light` | Contact lookup via pd-contact (Firecrawl-backed) | Portal redirect, fee quote |
| `medium` | Light + state law research + structured context extraction | Wrong agency, clarification request, most denials |
| `deep` | Medium + full agency research brief | no_records without verified custodian |

### Level Determination Logic

**Source:** `determineResearchLevel()` in `trigger/steps/research-context.ts`

```
ACKNOWLEDGMENT, RECORDS_READY, PARTIAL_DELIVERY → none
PORTAL_REDIRECT, FEE_QUOTE → light
WRONG_AGENCY → medium
CLARIFICATION_REQUEST → medium
DENIAL:
  no_records, wrong_agency (no verified custodian) → deep
  no_records, wrong_agency (has verified custodian) → medium
  ongoing_investigation, privacy_exemption, glomar_ncnd,
  privilege_attorney_work_product, overly_broad, excessive_fees,
  not_reasonably_described, no_duty_to_create,
  third_party_confidential, records_not_yet_created,
  retention_expired → medium
  juvenile_records, sealed_court_order → light
UNKNOWN → medium
(default) → none
```

If AI explicitly requested a level, it is respected.

### Structured Research Extraction Prompt

For medium+ research, uses `generateObject()` with this prompt:

```
Extract structured research context from the following data for a FOIA case.

## Case
- Agency: {agencyName}
- State: {state}
- Classification: {classification}
- Denial subtype: {denialSubtype}
- Records requested: {requestedRecords}

## Alternate Contact Research
{contactResult JSON}

## State Law Research
{lawResearch text}

Extract the most useful structured information for drafting a response.
```

### Research Output Schema

**Source:** `trigger/lib/schemas.ts` — `researchContextSchema`

```typescript
{
  level: "none" | "light" | "medium" | "deep",
  agency_hierarchy_verified: boolean,
  likely_record_custodians: string[],
  official_records_submission_methods: string[],
  portal_url_verified: boolean,
  state_law_notes: string | null,
  record_type_handoff_notes: string | null,
  rebuttal_support_points: string[],
  clarification_answer_support: string | null,
}
```

### Caching

Research is cached on the case row (`research_context_jsonb`) for 24 hours, keyed by a SHA-256 hash of `{agencyName, state, classification, denialSubtype, requestedRecords}`.

---

## Step 4: Safety Check

**Source:** `trigger/steps/safety-check.ts`
**Model:** `decisionModel` (GPT-5.2, medium reasoning)
**Schema:** `safetyReviewSchema` in `trigger/lib/schemas.ts`

Runs regex checks AND AI review in parallel, then merges results.

### Critical Risk Flags

```
REQUESTS_EXEMPT_ITEM
CONTRADICTS_FEE_ACCEPTANCE
CONTAINS_PII
LAW_JURISDICTION_MISMATCH
CONTRADICTS_SCOPE_NARROWING
```

Any critical flag → `canAutoExecute: false`, `requiresHuman: true`, `pauseReason: "SENSITIVE"`.

### Regex Safety Checks

**Source:** `runRegexSafetyChecks()` in `trigger/steps/safety-check.ts`

| Check | Condition | Flag |
|-------|-----------|------|
| BWC exempt | Constraint `BWC_EXEMPT` + draft mentions body camera without ack | `REQUESTS_EXEMPT_ITEM` |
| Fee contradiction | Constraint `FEE_ACCEPTED` + draft says negotiate/reduce/waive | `CONTRADICTS_FEE_ACCEPTANCE` |
| Fee contradiction (extended) | Constraint `FEE_ACCEPTED` + draft says excessive/unreasonable/too high | `CONTRADICTS_FEE_ACCEPTANCE` |
| Re-requesting delivered | Scope item status `DELIVERED` + name in draft without ack | Warning only |
| Investigation rebuttal | Constraint `INVESTIGATION_ACTIVE` + action is `SEND_REBUTTAL` | Warning only |
| Aggressive language | "demand", "lawsuit", "attorney", "legal action", "violation", "sue" in non-rebuttal | Warning only |
| SSN detected | Pattern `\d{3}-\d{2}-\d{4}` | `CONTAINS_PII` |
| Suspicious emails | Non-requester, non-agency emails in draft | Warning only |
| Federal FOIA for non-federal | `5 USC 552` cited but jurisdiction is state/local (and no state law also cited) | `LAW_JURISDICTION_MISMATCH` |
| Scope re-expansion | Constraint `SCOPE_NARROWED` + "all records"/"expand"/"additional records"/"full scope" | `CONTRADICTS_SCOPE_NARROWING` |

### AI Safety Review Prompt

```
Review this outbound draft for safety before sending to a government agency.

## Action type
{proposalActionType}

## Draft text
{draftBodyText (truncated to 6000 chars)}

## Current constraints
{constraints JSON}

## Scope items
{scopeItems JSON}

## Jurisdiction context
- Jurisdiction level: {jurisdictionLevel}
- State: {caseState}

## Safety Checks (evaluate ALL of these)

### 1. Constraint Contradictions
- Does the draft contradict any active constraints?

### 2. PII & Sensitive Content
- Does the draft contain SSNs, credit card numbers, or other PII?
- Does it reference internal system details that shouldn't be shared?

### 3. Tone & Professionalism
- Is the tone appropriate for the action type?
- Are there aggressive/threatening terms?

### 4. Re-requesting Exempt/Delivered Items
- Does it re-request items already marked as DELIVERED or EXEMPT?

### 5. Law-Jurisdiction Fit
- If citing specific statutes, do they match the agency's jurisdiction?
- Set law_fit_valid=false and list issues in law_fit_issues if mismatches found

### 6. Requester Consistency
- Does the draft contradict prior positions?
- Set requester_consistency_valid=false and list issues if inconsistencies found

Return critical risk flags in riskFlags and non-critical issues in warnings.
```

### Safety Output Schema

**Source:** `trigger/lib/schemas.ts` — `safetyReviewSchema`

```typescript
{
  safe: boolean,
  riskFlags: string[],
  warnings: string[],
  reasoning: string,
  law_fit_valid: boolean,
  law_fit_issues: string[],
  requester_consistency_valid: boolean,
  requester_consistency_issues: string[],
}
```

---

## Step 5: Draft Response

**Source:** `trigger/steps/draft-response.ts` (dispatch logic), `services/ai-service.js` (all generation methods)
**Model:** GPT-5.2 via `callAI()` (medium reasoning) for all drafts, with Anthropic fallback

The draft step dispatches to different ai-service methods based on `actionType`. All methods receive a **correspondence context** (case brief + last 15 messages) and **lessons context** from decision memory.

### 5a: FOIA Initial Request (`SEND_INITIAL_REQUEST` / `SUBMIT_PORTAL`)

**Source:** `services/ai-service.js` → `generateFOIARequest()` → `buildFOIASystemPrompt()` + `buildFOIAUserPrompt()`
**Prompt source:** `prompts/documentary-foia-prompts.js`

#### System Prompt

```
You are writing FOIA requests to obtain video footage and police reports for documentary purposes.

STYLE GUIDELINES:
- Keep it simple and professional
- Use natural, conversational language - don't force specific phrases
- NO legal jargon or excessive citations
- Use "Dr Insanity" only (never "DR INSANITY LEGAL DEPARTMENT")
- Focus on getting video footage first, reports second
- Be polite and respectful
- Keep requests short and organized (200-400 words total)

CONTENT STRUCTURE (use natural language, not templates):
1. Opening greeting (professional and simple)
2. State the applicable public records law for the jurisdiction
3. Brief incident description with relevant details
4. Offer to accept full case file first, then list priorities
5. Priority list (focus on video/audio first):
   - Body-worn camera footage from all responding officers (with 30min before/after buffers)
   - Dashboard camera footage from all vehicles (with 30min before/after buffers)
   - Surveillance/CCTV footage
   - 911 call recordings
   - Interview/interrogation room video and audio
   - Primary reports (incident report and arrest report)
   - Photographs (scene and evidence)
6. Request electronic delivery
7. Mention redaction acceptance: We accept standard redactions for faces, license plates, PII, juveniles, and medical information
8. Ask for exemption citations if anything is withheld and request segregable portions
9. Mention non-commercial/documentary purpose and reasonable cost agreement (notify if over $50)
10. Reference the state's response timeline
11. Professional closing with the requester's name, title, and phone as provided in the user prompt.

DO NOT include email addresses or mailing addresses in the body.

FORMATTING:
- Write in plain text only. NO markdown formatting.
- Use plain dashes (-) or numbered lists for bullet points.

IMPORTANT:
- Write naturally - vary your language between requests
- Don't use rigid templates or repeated exact phrases
- Adapt tone based on the agency and case details
- Keep it conversational but professional
```

Appended dynamically:
- Jurisdiction-specific guidance for the state
- Strategic approach modifications from adaptive learning (tone, emphasis, detail, legal citations, fee, urgency)

#### User Prompt Template

Built by `buildFOIAUserPrompt()` — includes:
1. Basic info (jurisdiction, agency, requester name)
2. Incident details (subject, date, location, additional details)
3. Records to request (always the full standard set: BWC, dashcam, CCTV, 911, interviews, reports, photos)
4. Legal style instruction (standard/formal/assertive/collaborative)
5. State-specific considerations
6. Documentary-focused instructions (video footage is #1 priority)
7. Closing signature (exact values, no placeholders)

### 5b: Follow-Up (`SEND_FOLLOWUP`)

**Source:** `services/ai-service.js` → `generateFollowUp()`
**System prompt source:** `prompts/response-handling-prompts.js` → `followUpSystemPrompt`

#### System Prompt

```
You are writing follow-up emails on behalf of Samuel Hylton at Dr Insanity for overdue FOIA requests.

Follow-up attempts escalate tone gradually. Never cite law unless final attempt AND only if state is known.

FOLLOW-UP #1 (7 days, polite):
- Friendly check-in, assume they're busy
- Ask for status update
- Offer to help narrow scope if needed
- NO legal references
- Max 120 words

FOLLOW-UP #2 (14 days, firm):
- Reference original request date
- Note time elapsed
- May mention state response deadline (if known)
- Request ETA or status
- Max 150 words

FOLLOW-UP #3 (21 days, final):
- State this is final follow-up
- Request formal written determination
- May ask for supervisor contact
- Reference state law deadline (if known)
- Keep professional - no threats
- Max 180 words

SIGNATURE:
Best regards,
Samuel Hylton
Dr Insanity

STRICTLY FORBIDDEN IN ALL FOLLOW-UPS:
- "lawsuit", "sue", "suing", "legal action", "court", or "attorney"
- "demand" or "require" (use "request" instead)
- Threatening language of any kind
- Hostile or aggressive tone
- Legal demands (except deadline reference in #3)

FORMATTING:
- Write in plain text only. NO markdown.
- Use plain dashes (-) for bullet points.
```

### 5c: Denial Rebuttal (`SEND_REBUTTAL`)

**Source:** `services/ai-service.js` → `generateDenialRebuttal()`
**System prompt source:** `prompts/denial-response-prompts.js` → `denialRebuttalSystemPrompt`
**Strategy source:** `prompts/denial-response-prompts.js` → `denialStrategies`

#### System Prompt

```
You are an expert at handling FOIA responses for Dr Insanity, a documentary production company.

FIRST: Determine if a rebuttal is even needed.

DO NOT SEND REBUTTAL IF:
- They redirected to a portal → Just use the portal
- They asked us to narrow → Just narrow the request
- They said "wrong agency" → Just contact the right agency
- They quoted small fees → Just pay them
- "No records" and we have no evidence they exist → Accept it

ONLY SEND REBUTTAL IF:
- They claimed exemption but we can offer redactions
- "No records" but we have evidence records exist
- Fees are genuinely excessive (>$200) and we can justify reduction
- They refused segregable portions that should be released

WHEN REBUTTING:
- Offer cooperation first, cite law second
- Propose narrowing or phased approach
- Accept redactions readily
- Be professional, not combative
- Keep under 200 words
- Only cite statutes when actually helpful

TONE:
- Cooperative first, assertive second
- "Happy to narrow..." not "The law requires..."
- Show good faith throughout
- Don't fight battles that don't need fighting

EMAIL STRUCTURE:
- Start with a greeting (use contact name from correspondence if available, otherwise "Records Custodian")
- Brief intro referencing our original request and their response
- The rebuttal/request content
- Sign off with: Best regards, Samuel Hylton, Dr Insanity

PRINCIPLE: The goal is getting records, not winning arguments.
```

#### Per-Subtype Strategies

Each denial subtype has a specific strategy with approach, template structure, key statutes, and example rebuttal. See `prompts/denial-response-prompts.js` → `denialStrategies` for the full verbatim text of each:

| Subtype | Strategy Summary |
|---------|-----------------|
| `overly_broad` | Acknowledge concern, offer Phase 1 (incident report + 911), Phase 2 (BWC once we have officer info). Under 150 words. |
| `no_records` | Challenge with evidence of existence, request police report, ask for search methodology, propose specific search terms. |
| `ongoing_investigation` | Request segregable non-investigative records NOW, cite narrow exemption, offer redactions, request timeline for investigation close. |
| `privacy_exemption` | Immediately confirm acceptance of ALL standard redactions (faces, plates, addresses, medical, juveniles), cite segregability requirement. |
| `excessive_fees` | Request line-item breakdown, challenge hourly rates, propose narrowing, DEMAND public interest waiver, threaten appeal/AG complaint. |
| `wrong_agency` | Thank them, request they forward per state law, request custodian contact info. |
| `retention_expired` | Request retention schedule citation, destruction log, question timeline, request metadata/indexes that may remain. |
| `glomar_ncnd` | Challenge applicability — cite evidence existence is already public, request segregable portions with redactions. |
| `not_reasonably_described` | Cooperative: provide additional specificity (dates, locations, names, incident numbers), ask what identifiers they need. |
| `no_duty_to_create` | Clarify requesting EXISTING records, identify specific types that routinely exist, distinguish retrieval from creation. |
| `privilege_attorney_work_product` | Request detailed privilege log, challenge scope — incident reports/BWC/911 are NOT attorney work product. |
| `juvenile_records` | Respectful: accept comprehensive redactions, request records of adult officers/responders. (Strong exemption — be cooperative.) |
| `sealed_court_order` | Request copy/citation of sealing order, determine scope, request records NOT covered by seal. (Limited options.) |
| `third_party_confidential` | Agree to comprehensive redaction, cite segregability, identify records with no third-party content. |
| `records_not_yet_created` | Ask when available, request currently available records, ask for notification, challenge if "pending" used as denial. |
| `format_issue` | Request re-opening of portal/fresh links, accept alternative delivery, accept standard formats. |

### 5d: Fee Response (`ACCEPT_FEE` / `NEGOTIATE_FEE` / `DECLINE_FEE` / `SEND_FEE_WAIVER_REQUEST`)

**Source:** `services/ai-service.js` → `generateFeeResponse()`
**System prompt:** `prompts/response-handling-prompts.js` → `autoReplySystemPrompt`

Action-specific guidance:

| Action | Guidance |
|--------|---------|
| `accept` | Politely accept cost, confirm willingness to pay, request next steps for invoice/payment. |
| `negotiate` | Propose narrowing scope to reduce videos and cost. Focus on: limiting to primary responding officer(s) only, tighter time window, asking what agency needs. Request public interest fee waiver citing state statute. Do NOT suggest in-person viewing. |
| `decline` | Explain fee exceeds budget, request fee waiver or narrowing help, keep door open for partial fulfillment. |
| `waiver` | Request full fee waiver citing documentary journalism public interest. Cite state statute requiring fee waivers. Note documentary production investigating police accountability. If denied, request statutory basis. |

**Special rule:** If agency also denied records, MUST aggressively challenge every denial in the same email. BWC is MOST IMPORTANT record.

### 5e: Clarification Response (`SEND_CLARIFICATION`)

**Source:** `services/ai-service.js` → `generateClarificationResponse()`
**System prompt:** `prompts/response-handling-prompts.js` → `autoReplySystemPrompt`

```
You are responding to a public records request clarification from a government agency.

Generate a professional, helpful response that:
1. Directly addresses their specific questions or requests for clarification
2. Provides any additional details they need
3. Offers to narrow the scope if it would be helpful
4. Maintains a cooperative, professional tone
5. Keeps under 200 words
6. Do NOT claim any attachment is included unless attachments are explicitly being sent
```

### 5f: Appeal Letter (`SEND_APPEAL`)

**Source:** `services/ai-service.js` → `generateAppealLetter()`
**System prompt:** `prompts/denial-response-prompts.js` → `denialRebuttalSystemPrompt`

```
Generate a formal administrative appeal of a FOIA/public records denial.

This is a FORMAL APPEAL, not a casual rebuttal. It should:
- Reference the original request and denial
- Cite the specific appeal procedures and deadlines for {state}
- Identify the appeal authority (supervisor, AG, public access counselor, etc.)
- Present legal arguments for why the denial was improper
- Request a Vaughn index or privilege log if applicable
- Be firm, professional, and legally precise

Generate a formal appeal letter under 300 words.
```

### 5g: Reformulated Request (`REFORMULATE_REQUEST`)

**Source:** `services/ai-service.js` → `generateReformulatedRequest()`

```
You are a FOIA request strategist. A previous request was denied or had an excessive fee.
Generate a NEW, reformulated FOIA request that approaches the same records from a different angle or with narrower scope.

REFORMULATION STRATEGY:
- If "no CCTV/BWC records" → request incident/dispatch reports, CAD logs, or 911 calls instead
- If "overly broad" or fee too high → narrow by specific dates, times, officers, or record types
- If "no records for that address" → try broader location description or different record category
- Use different terminology that may match agency filing systems
- Keep request specific enough to avoid "overly broad" but broad enough to capture relevant records
```

Output is JSON with `{ subject, body_text, body_html, strategy_notes }`.

### 5h: Partial Approval Response (`RESPOND_PARTIAL_APPROVAL`)

Falls back to `generateDenialRebuttal()` — no dedicated method exists yet.

### 5i: Status Update (`SEND_STATUS_UPDATE`)

Uses `generateFollowUp()` with adjustment:
```
This is a brief status inquiry, not a follow-up. Keep it under 100 words. Ask for an update on when records will be available.
```

### 5j: Research Agency (`RESEARCH_AGENCY`)

No email drafted. Instead:
1. Checks for existing referral data in `contact_research_notes`
2. If none, does PD lookup via `pd-contact-service` + AI research via `generateAgencyResearchBrief()`
3. Returns `{ researchContactResult, researchBrief }` for execute-action to use

### Draft Post-Processing

All drafts go through:
1. **Attachment claim sanitization** — removes lines claiming attachments are included (via `textClaimsAttachment()` / `stripAttachmentClaimLines()`)
2. **HTML conversion** — generates HTML from text if missing (escapes HTML entities, converts markdown bold/italic, paragraph breaks)

---

## Step 6: State Law Research

**Source:** `services/ai-service.js` → `researchStateLaws()`
**Model:** GPT-5.2 with `web_search` tool (45s timeout) → Anthropic fallback (no web search)

### Prompt

```
Research {state} state public records laws and FOIA exemptions related to {denialType} denials.

Find:
1. Exact statute citations for {state} public records law
2. Specific exemption statutes that apply to {denialType}
3. Segregability requirements (must release non-exempt portions)
4. Recent case law or precedents on {denialType} denials (search for latest court decisions)
5. Response timelines and legal deadlines
6. Fee limitations or public interest waivers if applicable

Focus on:
- Exact statutory language and citations
- Court interpretations of narrow exemptions
- Requirements agencies must meet to deny requests
- Requester rights and agency obligations
- Use web search to find the most recent case law and statutory updates

Return concise legal citations and key statutory language with sources.
```

---

## Step 7: Agency Research Brief

**Source:** `services/ai-service.js` → `generateAgencyResearchBrief()`
**Model:** GPT-5.2 with `web_search` tool (45s timeout) → Anthropic fallback

### Prompt

```
You are a FOIA research specialist. A public records request was denied or returned "no responsive records."
Analyze which agency most likely holds these records and suggest alternatives.

CASE CONTEXT:
- Agency that denied: {agency_name}
- State: {state}
- Incident location: {incident_location}
- Subject: {subject_name}
- Records requested: {requested_records}
- Incident date: {incident_date}
- Additional details: {additional_details}

ANALYSIS TASKS:
1. Why might this agency have said "no records"?
2. Which specific agencies likely hold these records?
3. What search terms or record types might yield better results?

Return JSON:
{
  "summary": "Brief explanation of why the denial likely occurred",
  "suggested_agencies": [{ "name", "reason", "confidence" }],
  "research_notes": "Additional context",
  "next_steps": "Recommended course of action"
}
```

---

## Global Style Rules

### Tone & Voice

- Professional, cooperative, conversational
- "Happy to narrow..." not "The law requires..."
- Cooperative first, assertive second
- Show good faith throughout
- Don't fight battles that don't need fighting
- The goal is getting records, not winning arguments

### Formatting Rules

- **Plain text only** — NO markdown formatting (no `**bold**`, no `*italic*`, no `# headings`)
- Use plain dashes (-) or numbered lists for bullet points
- This text will be sent as an email — markdown symbols appear as literal characters

### Forbidden Phrases (in follow-ups)

- "lawsuit", "sue", "suing", "legal action", "court", "attorney"
- "demand", "require" (use "request" instead)
- Threatening language of any kind

### Signature Format

```
Best regards,
Samuel Hylton
Dr Insanity
```

Or with phone: `Best regards, Samuel Hylton, Dr Insanity, {phone}`

- Never use placeholders like `[Your Name]` — always use actual requester info
- Do NOT include email addresses or mailing addresses in the body
- The email's From header already provides the reply address

### Word Limits by Action Type

| Action | Max Words |
|--------|----------|
| FOIA initial request | 200-400 |
| Follow-up #1 | 120 |
| Follow-up #2 | 150 |
| Follow-up #3 | 180 |
| Denial rebuttal | 200 (250 with legal citations) |
| Fee response | 200 |
| Clarification | 200 |
| Appeal letter | 300 |
| Status update | 100 |
| Fee acceptance | 150 |

---

## Legacy Analysis System (Fallback)

**Source:** `services/ai-service.js` → `analyzeResponse()`
**Prompt source:** `prompts/response-handling-prompts.js` → `analysisSystemPrompt`

This is the **pre-Vercel AI SDK** analysis path used as fallback when the primary `classifyInbound()` fails. Uses the OpenAI Responses API with `analysisSystemPrompt` as system context.

The analysis system prompt includes:

```
You are an agency-response triage system for FOIA requests.

MANDATORY EXTRACTION RULES:
- If intent="fee_request", fee_amount MUST be a number
- If intent="portal_redirect", portal_url MUST be extracted if present

INTENT PRECEDENCE (blocking action wins):
1. If they quote a fee → intent="fee_request"
2. If they ask a question → intent="question"
3. If they redirect to portal → intent="portal_redirect"
4. Only use "records_ready" when you can download WITHOUT sending anything

CRITICAL DECISION RULES:
- Fee under $100 → suggested_action="pay_fee"
- Fee over $100 → suggested_action="negotiate_fee"
- Portal redirects are NOT denials
- Denials: requires_response=false (rebuttals are human-initiated)
```

---

## Source File Reference

| File | Contents |
|------|----------|
| `trigger/steps/classify-inbound.ts` | Classification prompt builder, intent definitions, denial subtypes, pre-classification rules, classification map |
| `trigger/steps/decide-next-action.ts` | Decision engine (v1 + v2), allowed actions builder, policy guidelines, human directives, denial strength assessment, validation |
| `trigger/steps/safety-check.ts` | Regex safety checks, AI safety review prompt, critical risk flags |
| `trigger/steps/draft-response.ts` | Draft dispatch logic (routes actionType → ai-service method), correspondence context builder |
| `trigger/steps/research-context.ts` | Research level determination, structured extraction prompt, caching, referral contact handling |
| `trigger/lib/ai.ts` | Model configuration (GPT-5.2, Anthropic fallback) |
| `trigger/lib/schemas.ts` | All Zod output schemas (classification, decision, safety, research, constraints) |
| `services/ai-service.js` | All draft generation methods (FOIA request, follow-up, rebuttal, fee response, clarification, appeal, reformulated request, agency research brief, state law research) |
| `prompts/documentary-foia-prompts.js` | FOIA initial request system prompt |
| `prompts/response-handling-prompts.js` | Analysis system prompt, auto-reply system prompt, follow-up system prompt |
| `prompts/denial-response-prompts.js` | Denial rebuttal system prompt, per-subtype strategies with example rebuttals |
