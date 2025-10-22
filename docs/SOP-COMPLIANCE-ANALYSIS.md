# SOP Compliance Analysis

## Overview
Analysis of how the FOIA automation bot aligns with Matcher's SOPs from Notion.

---

## ✅ CURRENTLY COMPLIANT

### 1. **Request Scope & Principles**
**SOP**: Initial request includes Police Report + core media (primary BWC, interrogation, 911 MP3)

**Bot Status**: ✅ **COMPLIANT**
- `prompts/documentary-foia-prompts.js` prioritizes:
  1. Body-worn camera footage
  2. Dashboard camera footage
  3. Surveillance/CCTV footage
  4. 911 call recordings
  5. Interview/interrogation room video
  6. Primary reports (incident & arrest)
  7. Photographs

**Evidence**: Lines 29-36 in documentary-foia-prompts.js

---

### 2. **Natural, Conversational Tone**
**SOP**: Be professional but not overly formal or legalistic

**Bot Status**: ✅ **COMPLIANT**
- System prompts emphasize "natural, conversational language"
- Explicitly states: "Don't use phrases like 'pursuant to' or 'per statute'"
- Avoids rigid templates
- Varies language between requests

**Evidence**:
- `prompts/documentary-foia-prompts.js` lines 9, 45-48
- `prompts/response-handling-prompts.js` lines 6-12, 50-58

---

### 3. **Brief Communication**
**SOP**: Keep emails concise (150-200 words for replies, 200-400 for requests)

**Bot Status**: ✅ **COMPLIANT**
- Initial requests: 200-400 words
- Auto-replies: Under 150 words
- Follow-ups: 100-200 words

**Evidence**:
- documentary-foia-prompts.js line 14
- response-handling-prompts.js lines 57, 91

---

### 4. **Requester Information**
**SOP**: Always include proper contact info

**Bot Status**: ✅ **COMPLIANT**
- Name: Samuel Hylton
- Email: Samuel@matcher.com
- Address: 3021 21st Ave W, Apt 202, Seattle, WA 98199
- Uses "Matcher" (not "MATCHER LEGAL DEPARTMENT")

**Evidence**: documentary-foia-prompts.js lines 16-22

---

### 5. **State-Specific Legal Citations**
**SOP**: Reference applicable state law and response deadlines

**Bot Status**: ✅ **COMPLIANT**
- Bot references state-specific public records laws
- Includes response timeline citations
- Uses state database for deadline calculations

**Evidence**:
- services/ai-service.js uses state data
- services/notion-service.js calculateDeadline() method

---

## ⚠️ PARTIALLY COMPLIANT / NEEDS ENHANCEMENT

### 6. **Redaction Acceptance**
**SOP**: "We accept redactions for PII/juveniles/medical/plates/faces"

**Bot Status**: ⚠️ **PARTIAL**
- Not explicitly stated in initial request prompts
- Should proactively mention in requests

**Recommendation**: Add to documentary-foia-prompts.js:
```
- Mention willingness to accept standard redactions (faces, plates, PII, juveniles)
```

---

### 7. **Narrowing & Scoping Strategy**
**SOP**:
- Request line-item breakdown
- Ask for duration/file count before processing
- Propose phased delivery if costs are high

**Bot Status**: ⚠️ **PARTIAL**
- Auto-reply prompt mentions cooperation on narrowing
- Doesn't proactively request line-item breakdowns
- Doesn't mention phased delivery

**Recommendation**: Add to response-handling-prompts.js auto-reply section:
```
If they mention fees:
- Request line-item breakdown (search, review, redaction, export/media)
- Ask for file durations and counts
- Propose phased delivery (Phase 1: core media; Phase 2: extras)
```

---

### 8. **Denial Response Strategies**
**SOP**: Has specific playbooks for 8 denial types:
1. No responsive records
2. Ongoing investigation
3. Privacy/victim protection
4. Overly broad
5. Excessive fees
6. Wrong agency
7. Retention/destroyed
8. Format/portal issues

**Bot Status**: ⚠️ **NEEDS WORK**
- Auto-reply only handles simple intents: acknowledgment, fee_request, more_info_needed
- Doesn't have denial-specific response logic
- Should add denial intent detection and specific responses

**Recommendation**:
- Expand analysisSystemPrompt to detect denial subtypes
- Add denial-specific auto-reply templates
- Create separate prompt section for each denial type

---

### 9. **Police Report as Fallback**
**SOP**: "If media was refused: Ask for Police Report (if not already produced) and re-scope from it"

**Bot Status**: ❌ **MISSING**
- No logic to request police report only when media is denied
- Should detect denial and pivot to report-only request

**Recommendation**: Add denial handler that:
1. Detects media denial
2. Requests police report only
3. Uses report to build targeted second request

---

### 10. **Multi-Channel Strategy**
**SOP**: Portal > Email > Fax > Phone (in order of preference)

**Bot Status**: ⚠️ **PARTIAL**
- Currently only handles email sending
- Portal URL field exists in Notion but not used
- No fax or phone call integration

**Recommendation**:
- Phase 1: Add portal detection logic
- Phase 2: Consider portal automation or manual flagging
- Fax/phone remain manual for now

---

## ❌ NOT YET IMPLEMENTED

### 11. **Follow-Up Cadence**
**SOP**:
- 1st follow-up: At statutory deadline
- 2nd follow-up: +7-14 days
- 3rd follow-up: +7 days, mention escalation

**Bot Status**: ❌ **NEEDS IMPLEMENTATION**
- Follow-up scheduling exists (email-queue.js lines 63-74)
- Follow-up generation exists (ai-service.js generateFollowUp)
- **BUT**: Needs to track follow-up count and adjust tone accordingly

**Recommendation**: Enhance generateFollowUp to:
- Check follow_up_count from database
- Apply correct escalation tone (friendly → direct → firm)
- Reference prior follow-ups in message

---

### 12. **Notion Logging Requirements**
**SOP**: "If you learn it or send it, you log it"
- Update Status immediately
- Update Sub-Status to track progress
- Set Expected Response Date
- Update Included Records
- Log denial reasons

**Bot Status**: ⚠️ **PARTIAL**
- Bot updates Status on send (email-queue.js line 56)
- Syncs to Notion (notion-service.js syncStatusToNotion)
- **MISSING**: Sub-Status updates, Included Records updates

**Recommendation**: Add more granular Notion updates:
- Sub-Status changes based on response analysis
- Update Included Records when scope is narrowed
- Add comments for significant events

---

### 13. **Time Buffers for Video**
**SOP**: Request time buffers around incidents (e.g., "30 minutes before and after")

**Bot Status**: ⚠️ **MENTIONED BUT NOT SPECIFIC**
- Prompts mention "time buffers" generically
- Doesn't specify "30 minutes before and after"

**Recommendation**: Add to documentary-foia-prompts.js:
```
- Request reasonable time buffers (typically 30 minutes before first arrival and 30 minutes after incident conclusion)
```

---

### 14. **Officer Names & Badge Numbers**
**SOP**: "Include officer names/badge numbers when provided"

**Bot Status**: ✅ **COMPLIANT**
- Prompts request officer names and badge numbers
- User prompt template includes officer_details field

**Evidence**: services/ai-service.js lines 236-238

---

### 15. **Proof of Existence Strategy**
**SOP**: "Provide proof of existence (news/docs) if available. Offer to narrow and confirm redaction acceptance"

**Bot Status**: ❌ **NOT IMPLEMENTED**
- No mechanism to attach news articles or documentation
- Could enhance by including case summary with links

**Recommendation**:
- Include relevant news links from Case Summary in denial rebuttals
- Mention "public reporting indicates..." when appropriate

---

## 🎯 PRIORITY RECOMMENDATIONS

### HIGH PRIORITY (Implement Soon)

1. **Add Redaction Acceptance Statement** ⚠️
   - File: `prompts/documentary-foia-prompts.js`
   - Add: "We accept standard redactions (faces, plates, PII, juveniles, medical information)"

2. **Enhance Denial Detection & Response** ❌
   - File: `prompts/response-handling-prompts.js`
   - Add: Specific prompts for each of the 8 denial types
   - File: `services/ai-service.js`
   - Add: Denial subtype detection in analyzeResponse

3. **Police Report Fallback Logic** ❌
   - File: `services/ai-service.js`
   - Add: When media is denied, generate report-only request

4. **Specific Time Buffers** ⚠️
   - File: `prompts/documentary-foia-prompts.js`
   - Change: "reasonable time buffers" → "30 minutes before and after"

### MEDIUM PRIORITY (Next Phase)

5. **Enhanced Notion Logging** ⚠️
   - File: `services/notion-service.js`
   - Add: Sub-Status updates
   - Add: Included Records field updates
   - Add: Comments for key events

6. **Line-Item Breakdown Requests** ⚠️
   - File: `prompts/response-handling-prompts.js`
   - Add: Automatic request for cost breakdowns when fees mentioned

7. **Follow-Up Escalation Tracking** ❌
   - File: `services/ai-service.js` generateFollowUp
   - Enhance: Track follow-up count and escalate tone accordingly

### LOW PRIORITY (Future Enhancement)

8. **Portal Integration** ⚠️
   - Research: Portal automation feasibility
   - Alternative: Flag portal cases for manual handling

9. **Proof of Existence** ❌
   - Enhancement: Include news links in denial rebuttals

---

## COMPLIANCE SCORE

**Overall Compliance: 65%**

- ✅ Fully Compliant: 5 areas (33%)
- ⚠️ Partially Compliant: 7 areas (47%)
- ❌ Not Implemented: 3 areas (20%)

**Key Strengths:**
- Natural conversational tone
- Proper requester information
- Video-first priority approach
- State-specific legal citations
- Brief, professional communication

**Key Gaps:**
- No denial-specific responses
- Missing police report fallback
- Limited Notion logging granularity
- No multi-channel support (portal/fax)
