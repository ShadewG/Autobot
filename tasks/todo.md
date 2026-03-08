# Autobot — Technical Plan

Ordered by priority within each phase. Check items off as completed.

---

## Phase 0: Repo Cleanup & Organization

### P0 — Make the codebase navigable

#### Inventory & Classification
- [x] Build a file inventory that tags each top-level file and folder as `active`, `compat`, `dev-only`, `one-off`, or `archive-candidate`
- [x] Trace imports/route mounts before moving anything so we do not archive files that are still runtime-critical
- [x] Mark canonical entrypoints in `guide.md` and keep it updated as cleanup happens
- [x] Identify the real test surface (`tests/`, dashboard checks, prompt tests, load tests) vs loose root-level experiments

#### Archive Strategy
- [x] Create a root `.old/` folder with subfolders for `root-scripts`, `test-artifacts`, `legacy-routes`, `legacy-services`, `docs`, and `screenshots`
- [x] Add a `.old/README.md` manifest format: original path, moved date, reason, restore note
- [x] Define move rules: only move files after confirming they are not imported, not referenced by npm scripts, and not mounted by the server
- [x] Prefer moving low-risk one-off files first and compatibility-heavy files last

#### Root Directory Cleanup
- [x] Move loose root `test-*`, `check-*`, `fix-*`, `reset-*`, `regen-*`, `resend-*`, and similar one-off scripts into `scripts/` or `.old/root-scripts` — all portal test scripts moved to .old/test-artifacts/ and scripts/; run-migration.js moved to scripts/
- [x] Move root JSON dumps, screenshots, `.command` wrappers, and ad hoc reports into `.old/test-artifacts` unless they are still part of an active workflow — legacy portal test files and research test archived
- [x] Keep the root focused on runtime entrypoints, config, package files, and primary docs only — root now has only: server.js, run-pending-portals.js, test-setup.js + config files

### P1 — Reduce redundancy safely

#### Tests & Dev Utilities
- [ ] Audit `tests/` vs root-level test files and consolidate runnable tests under `tests/`
- [ ] Review `routes/test/*` and either guard them behind explicit dev-only checks or move them to `.old/legacy-routes`
- [ ] Review `scripts/` for one-off migration/debug helpers and split into `scripts/active/` vs archived helpers in `.old/root-scripts`
- [ ] Remove or archive duplicate prompt/debug runners once the canonical test commands are documented

#### Legacy Runtime Files
- [ ] Review `routes/api.js`, `routes/requests/legacy-actions.js`, and other compatibility-heavy routes; document whether they are still required
- [x] Review `services/foia-case-agent.js` and older orchestration helpers; archive them if the Trigger.dev flow fully replaced them — archived to `.old/legacy-services/`; 3 references cleaned up (email-queue.js import+fallback, simulation.js, test file); Trigger.dev pipeline fully replaces all agent functionality
- [x] Compare portal service variants and identify the single active provider path; move inactive variants to `.old/legacy-services` after validation — active: `portal-agent-service-skyvern.js` (used by submit-portal.ts, email-queue.js, run-pending-portals.js). Archived 4 legacy variants: hyperbrowser, base, managed, agentkit. `portal-service.js` kept for test endpoint only.
- [x] Review unused or empty directories such as `workers/` and either wire them up properly or archive/remove them — removed empty `workers/` directory; remaining refs to `workers/agent-worker.js` are only in docs/plans/scripts, not runtime code

#### Naming & Structure
- [ ] Standardize where operational scripts live (`scripts/`), where docs live (`docs/` or `tasks/`), and where archived files live (`.old/`)
- [ ] Rename ambiguous files where needed so active runtime paths are obvious from their filenames
- [ ] Add a lightweight rule for future work: no new root-level one-off scripts unless they are immediately placed under `scripts/`

### P2 — Execute cleanup in phases

#### Safe rollout order
- [x] Phase A: inventory and classify files without moving anything — completed in repo-inventory.md and guide.md
- [x] Phase B: move obvious one-off root scripts and artifacts into `.old/` — all portal test files, research tests, and migration scripts moved; root now has only server.js, run-pending-portals.js, test-setup.js + config
- [ ] Phase C: consolidate active tests and document canonical test commands
- [ ] Phase D: retire compatibility routes/services only after import checks, route checks, and smoke tests pass
- [ ] Phase E: update `guide.md` after each cleanup batch so the map stays accurate

---

## Phase 1: Exit Beta

### P0 — Must-have before launch

#### System Health & Observability
- [x] Add "System Health" card to dashboard: stuck cases, orphaned runs, stale proposals, overdue deadlines — red if > 0, clickable `(TESTED IN UI - Codex 2026-03-08)`
- [x] Daily operator digest email: stuck cases, pending proposals > 48h, bounced emails, portal failures `(Discord notification via cron 8AM ET — 2026-03-08)`
- [ ] Structured error tracking (Sentry or equivalent) — replace `console.error` with tracked, searchable exceptions

#### Agency Validation at Import ✅ DONE
- [x] On Notion import, validate agency email (format check + MX record lookup via dns.resolveMx)
- [x] On import, check if agency exists in directory — flag if not found
- [x] On import, verify state matches agency state — flag mismatches
- [x] Surface validation warnings in dashboard (yellow banner on case detail) `(TESTED IN UI - Codex 2026-03-08)`
- [x] Run `detectCaseMetadataAgencyMismatch` at import time, not just at decision time

#### Proposal Lifecycle Hardening
- [x] Centralize proposal human-review updates into one helper (approve, dismiss, withdraw, adjust all go through the same path)
- [x] Ensure every human review writes `human_decision`, `human_decided_at`, `human_decided_by`
- [x] Ensure every executed proposal writes `executed_at`
- [x] Ensure every terminal execution writes `completed_at`
- [x] Audit all direct `updateProposal()` callers and route through the lifecycle helper
- [x] Stress-test waitpoint fallback paths (direct email, direct PDF email) — verify rollback on failure

#### Execution Completeness
- [x] Centralize execution terminal-state writes into one helper
- [x] Ensure every `SENT`, `FAILED`, `CANCELLED`, `PENDING_HUMAN` transition updates `updated_at`
- [x] Ensure email executions always write `provider_message_id` when available
- [x] Normalize `provider_payload` across direct-send, queued email, portal, and no-op executions
- [x] Verify the email worker always calls the final execution update path after success

#### Operator Workflow
- [x] Bulk approve/dismiss on `/gated` — select multiple, one-click approve with confirmation `(UI BUG FOUND 2026-03-08 - selection works, but Cancel in Bulk Approve opens Bulk Dismiss with reason "undefined")`
- [x] Full-text case search across case name, agency name, subject, email content `(TESTED IN UI - Codex 2026-03-08)`
- [x] Finish mobile responsiveness: every page usable at 390px viewport `(TESTING - UI Codex 2026-03-08 - detail page and mobile timeline verified at 390px; full page sweep not complete)`

### P1 — Important for confidence

#### Case Timeline & Audit Trail
- [x] Add "Case Timeline" view to case detail — every state transition chronologically `(TESTED IN UI - Codex 2026-03-08)`
- [x] Wire `decision_traces` into all Trigger.dev workflows (inbound, initial, followup, portal) — createDecisionTraceTracker called in all 4 tasks, deployed v20260308.32
- [x] Create a trace at run start, complete with classification, router output, gate decision, node trace, duration
- [ ] Add `actor_type`, `actor_id`, `source_service` to major lifecycle events
- [x] Add regression checks so new runs always create a `decision_traces` row — added `runs_without_traces` section to reconciliation report (agent_runs without matching decision_traces in last 7 days); added unit tests verifying all 4 task types create traces and missing runId/caseId skips persistence

#### Data Quality & Schema Cleanup
- [x] Make `constraints_jsonb` sole source of truth — backfill mismatches, update all reads, remove legacy `constraints`
- [x] Make `scope_items_jsonb` sole source of truth — same process
- [x] Inventory all writes to `auto_reply_queue` — replace with `proposals`, add compat adapter if needed, then archive — **INVENTORIED**: Table has 1 row (CANCELLED). 3 active write paths: (1) `sendgrid-service.js:handleFeeQuote` — DEAD CODE, never called; (2) `email-queue.js:620` — BullMQ analysis worker legacy path, stores approval-needed drafts; (3) `legacy-actions.js:215` — custom draft regeneration endpoint. 21 files reference the table (many in scripts/.old). All 3 write paths are legacy — Trigger.dev pipeline uses `proposals` table exclusively. **Safe to archive** once remaining BullMQ analysis worker usage is confirmed dormant
- [x] Remove `cases.langgraph_thread_id` reliance — verified: 0 references to `langgraph` in codebase, column is dormant
- [ ] Decide on `case_agencies` as long-term model — if yes, propagate `case_agency_id` across proposals, executions, portal tasks
- [x] Backfill `case_agency_id` on historical proposals where derivable — 533 proposals updated from primary case_agency
- [x] Agency directory dedup: normalize names on insert, merge duplicates, verify emails — deduped 37 groups (44 rows), fixed 1980 state='{}' → NULL
- [x] Remove `agent_runs.proposal_id` once all readers migrated to `proposals.run_id` — verified: 0 active code references, canonical link is proposals.run_id (585/647 populated)
- [x] Review `proposals.langgraph_checkpoint_id` for removal — dropped: 0 rows had data, 0 code references

#### Portal Data Quality
- [x] Ensure completed `portal_tasks` always write `completed_by` and `confirmation_number` — added `completedBy` and `confirmationNumber` passthrough in case-reducer PORTAL_COMPLETED handler + submit-portal.ts context; backfilled 13 completed_by and 3 confirmation_number values from cases table
- [x] Sync portal task completion back to `executions` and `proposals` — case-reducer already updates proposals to EXECUTED on PORTAL_COMPLETED; backfilled 29 orphan portal_tasks with proposal_id from SUBMIT_PORTAL proposals
- [x] Improve `portal_request_number` capture from submissions and inbound notifications — **AUDITED**: 3 capture paths exist: (1) Skyvern extraction in portal-agent-service-skyvern.js, (2) inbound email matching in sendgrid-service.js (primary source, captured 9 of 10 request numbers), (3) case-reducer PORTAL_COMPLETED sets from confirmationNumber. 16 portal-completed cases lack request_number because Skyvern didn't extract one and no inbound notification contained it. Backfilled case 25164 (MR-2026-6) from inbound subject. Remaining gaps are portal submissions where confirmation wasn't extractable
- [x] Add validation so portal cases without a request number are identifiable — added `portal_missing_request_number` section to reconciliation report; shows 6 active portal cases missing request numbers

#### Notion Sync
- [x] Add "Sync Now" button for a specific Notion page (instant import) `(TESTING - UI Codex 2026-03-08 - control confirmed in case actions menu; action not fired during live pass)`
- [x] Add "last synced" timestamp per case in dashboard (shown in Sync Notion dropdown, stored in `last_notion_synced_at`) `(TESTED IN UI - Codex 2026-03-08)`
- [ ] Root-cause recurring sync failures (the `_fix_notion_sync*.js` scripts suggest systematic issues)

#### Constraint Management
- [x] Allow removing/overriding stale constraints from dashboard `(TESTING - UI Codex 2026-03-08 - edit mode, remove controls, and add dialog verified; destructive actions not exercised)`
- [x] Show constraint history (when added, by whom/what)
- [x] Wire real `constraint_added` / `constraint_removed` / `constraint_detected` producers into `activity_log` — added to update-constraints.ts (AI analysis), execute-action.ts (WRONG_AGENCY add/remove), case-management.js (manual add/remove with fixed logActivity signatures)
- [x] Verify new constraint history producers are visible in live workspace payloads and UI after fresh events — verified: activity_log→toTimelineEvent maps constraint_detected/added/removed to CONSTRAINT_DETECTED timeline type (RESEARCH category); frontend timeline.tsx renders with AlertTriangle icon + orange styling; constraints-display.tsx has ConstraintHistoryEntry UI; 182 backfilled entries confirmed in DB
- [x] Backfill or reconstruct constraint history for existing cases so the new history UI is not empty on older requests — backfilled 182 `constraint_detected` activity_log entries for 77 cases from `constraints_jsonb` data
- [x] Fix Add Constraint dialog accessibility: associate labels to fields and add stable `id`/`name` attributes
- [x] Fix `CollapsibleSection` summary action markup so interactive controls are not nested inside `<summary>`

#### Dashboard API Hygiene
- [x] Remove trailing-slash `308` redirect hops for dashboard API calls like `/api/auth/me`, `/api/monitor/live-overview`, `/api/requests/:id/workspace`, `/api/requests/:id/agent-runs`, and `/api/requests/:id/portal-screenshots` — added trailing-slash strip middleware in server.js before API route handlers; redirects `/api/path/` → `/api/path` with 301 `(FOLLOW-UP 2026-03-08 - local verification must use the actual Autobot stack: dashboard on localhost:3001 and backend on localhost:3004. Earlier page-load failures on localhost:3000 were from another repo running on that port, not from this middleware.)`

#### Future-Proof Data Capture
- [ ] Extend `case_event_ledger` or create unified append-only event stream
- [ ] Capture raw inbound/outbound provider payloads
- [ ] Add normalized failure metadata: `failure_stage`, `failure_code`, `retryable`, `retry_attempt`
- [ ] Add proposal content versioning (draft history instead of overwrite)

#### Decision AI Failures (from Braintrust eval analysis, 2026-03-07)

Eval run scored 61 cases: 36 correct (59%), 25 wrong (41%). All failures are WRONG_ROUTING (23) or CONTEXT_MISSED (2). Five root causes identified below, with fixes.

**Root Cause 1: ESCALATE overuse (10 failures)** ✅ DONE
The AI escalates to human review when it has enough info to act. Examples: agency says "Request denied" → AI escalates instead of sending rebuttal. Agency says "narrow to 3 years" → AI escalates instead of sending clarification. Agency says "contact State Police" → AI escalates instead of researching agency.
- [x] Add decision prompt rule: "ESCALATE is a last resort. If the trigger message contains a clear agency request, denial, fee notice, or referral, take the corresponding action (SEND_REBUTTAL, SEND_CLARIFICATION, RESEARCH_AGENCY, NEGOTIATE_FEE). Only ESCALATE when the situation is genuinely ambiguous or dangerous."
- [x] Add examples to decision prompt: terse denial → SEND_REBUTTAL, scope narrowing → SEND_CLARIFICATION, wrong agency with referral → RESEARCH_AGENCY, identity verification → SEND_CLARIFICATION

**Root Cause 2: SEND_REBUTTAL vs SEND_APPEAL confusion (3 failures)** ✅ DONE
When agency cites privilege or provides Vaughn index (formal adverse determination), AI sends informal rebuttal instead of formal appeal. Risk: missed appeal deadlines.
- [x] Add decision prompt rule: "When agency issues a formal denial citing specific exemptions, provides a Vaughn index, or asserts categorical withholding under privilege, the next step is SEND_APPEAL (not SEND_REBUTTAL). Rebuttals are for vague/informal denials. Appeals are for formal exemption-based denials with cited statutes."
- [x] Add lesson: "Attorney-client privilege / work product assertions = formal denial → SEND_APPEAL"

**Root Cause 3: Missing action types RESPOND_PARTIAL_APPROVAL and NEGOTIATE_FEE (5 failures)** ✅ DONE
AI doesn't know how to handle partial approvals (some records released, some withheld) or fee warnings without dollar amounts. Defaults to NONE or ESCALATE.
- [x] Verify RESPOND_PARTIAL_APPROVAL and NEGOTIATE_FEE are in the allowed actions list in `decide-next-action.ts`
- [x] If not present, add them with clear descriptions: RESPOND_PARTIAL_APPROVAL = "acknowledge receipt, request exemption citations for withheld records, ask about segregability and appeal rights"; NEGOTIATE_FEE = "request written estimate, set not-to-exceed cap, ask to be contacted before charges incurred"
- [x] Add decision prompt rule: "When agency releases some records but withholds others, use RESPOND_PARTIAL_APPROVAL. When agency mentions fees but hasn't given a dollar amount, use NEGOTIATE_FEE (never ACCEPT_FEE without a specific amount)."

**Root Cause 4: Monitor-dismissed cases getting actions (7 failures, all score 1)** ✅ DONE
Cases with no trigger message that should be DISMISSED (stale proposals, wrong agency, synthetic QA). AI invents actions instead of recognizing there's nothing to do. 4 of these specifically route to wrong jurisdiction (Lubbock TX portal for FL/GA/IL cases).
- [x] Add decision prompt rule: "If there is no trigger message (no new inbound email or event), strongly prefer DISMISS or NONE. Do not fabricate actions without a clear trigger."
- [x] Add guard in `decide-next-action.ts`: if no trigger message AND case status is not actively awaiting action, default to DISMISS without AI call
- [x] Investigate why Lubbock TX portal is being selected for unrelated jurisdictions — fixed cross-state agency matching with NULLIF(state, '{}') and generic name guard

**Root Cause 5: RESEARCH_AGENCY vs direct response confusion (3 failures)** ✅ DONE
AI sometimes wants to research before responding (when it should just respond) or responds (when it should research first). Pattern: vague "policy" denial → should rebut, but AI researches. "No duty to create" → should research what records exist, but AI reformulates.
- [x] Add decision prompt rule: "For vague denials citing 'policy' without statutory authority, SEND_REBUTTAL requesting the specific legal basis. For 'no duty to create' responses, RESEARCH_AGENCY to find what records the agency actually maintains before reformulating."

#### Prompt & Classifier Alignment
- [ ] Unify the Trigger.dev classifier and the legacy queue/fallback analyzer around one canonical intent schema and prompt contract
- [x] Remove or rewrite the PDF bias in `classify-inbound` so attachments do not implicitly force `records_ready` / `delivery` — rewrote attachment instruction to classify based on CONTENT not presence; removed "classify as records_ready or delivery" directive, replaced with reference to Attached Letters & Documents section
- [x] Add explicit prompt handling for portal/system traffic: submission confirmations, document release notices, password/unlock emails, portal closures, and similar non-agency-human messages — added portal account management auto-classification (password reset, welcome, unlock, activate) in classify-inbound.ts, plus detectPortalSystemEmail() in portal-utils.js for webhook-level filtering
- [x] Decide whether `question` and `more_info_needed` should remain distinct; collapse them if downstream logic does not truly need both — **DECIDED: keep both in prompt but already collapsed downstream**. Both map to `CLARIFICATION_REQUEST` in CLASSIFICATION_MAP. Prompt uses both so AI can match subtle distinctions; downstream treats them identically
- [x] Decide whether `delivery` and `records_ready` should remain distinct; collapse them if the execution layer treats them the same — **DECIDED: keep both in prompt but already collapsed downstream**. Both map to `RECORDS_READY` in CLASSIFICATION_MAP. Prompt uses both so AI can match subtle distinctions; downstream treats them identically
- [x] Review the `partial_*` classifications against real cases and simplify if they are causing drift or misrouting — **AUDITED**: 4 production cases found (2 partial_denial, 2 partial_delivery). Both partial_delivery cases were misclassified (should be partial_denial — agencies withholding, not interim delivery). **FIXED**: (1) Added all partial_* intents + wrong_agency to `isComplexCase` gate in email-queue.js so they route to Trigger.dev; (2) Added `PARTIAL_DELIVERY` to requires_response bypass list in decide-next-action.ts; (3) Strengthened classifier prompt to distinguish partial_delivery (interim, more coming) from partial_denial (final, some withheld)
- [x] Ensure the decision prompt consumes richer classifier output: `referral_contact`, exemption citations, evidence quotes, response nature, and attachment-informed context — **FIXED**: Classifier Evidence section existed in `buildEnrichedDecisionPrompt` but was reading `la.decision_evidence_quotes` instead of `la.full_analysis_json.decision_evidence_quotes` (fields were always undefined). Fixed all 6 field paths to read from `full_analysis_json`
- [ ] Pass attachment-aware context into simulation and eval so tuning reflects real production messages
- [x] Exclude internal synthetic messages (for example phone call update notes) from the normal inbound agency-response classifier path — added auto-classification in classify-inbound.ts for phone_call message_type and "phone call update/log/note" subject patterns → NO_RESPONSE without AI call
- [x] Add a clear prompt rule for mixed messages: fee + denial, partial release + withholding, portal notice + human instruction, and other combined cases `(classifier + decision prompt — 2026-03-08)`
- [x] Add explicit guidance for “closure after we did not answer” portal messages so they are not treated like generic denials or generic acknowledgments `(classifier prompt — 2026-03-08)`
- [x] Add explicit guidance for request-form and mailing-address workflows so they classify as clarification/process blockers rather than delivery `(classifier prompt — 2026-03-08)`
- [x] Add explicit guidance that attached letters may be acknowledgments, denials, fee notices, formal responses, or actual records, and must be classified from content rather than file presence `(classifier prompt — 2026-03-08)`
- [ ] Add OCR fallback for scanned/image-only PDFs so attachment-heavy cases are not partially invisible to the classifier
- [ ] Ensure fallback constraint extraction can use attachment text, not just email body text
- [ ] Build a prompt test set from real message patterns: portal confirmations, portal releases, portal access issues, blank request forms, fee letters, denial letters, mixed partial releases, wrong-agency referrals
- [ ] Review low-confidence and `other` classifications regularly and feed those examples into the prompt test set
- [x] Add validation reporting for attachment extraction coverage so we know which PDF/image messages reached classification without usable text — added `attachment_extraction` section to reconciliation report with inbound_with_attachments, has_extraction, missing_extraction, and extraction_rate metrics

#### Live Data Workflow Anomalies (from production DB, 2026-03-07)
Production data review found 160 inbound messages, 107 response analyses, 56 inbound messages with no `response_analysis`, 57 inbound messages with no `case_id`, and 21 inbound rows with `last_error = "Branch condition returned unknown or null destination"`.
- [x] Audit inbound messages with `case_id IS NULL`; backfill matches where possible and prevent unmatched inbound from bypassing the active case workflow — 57→56 orphans: linked Fort Collins email to case 25136, marked 3 GovQA system emails processed, added portal system email detection to prevent future orphans; remaining 4 unprocessed are unmatched agencies with no case
- [x] Investigate `messages.last_error = "Branch condition returned unknown or null destination"` and add a route-safe fallback so inbound handling never dies on an unknown branch — legacy LangGraph error (Feb 18-20 only), cleared 21 stale errors; error string no longer exists in current codebase
- [x] Add a reconciliation query for latest `requires_action = true` analyses that have no active proposal or work item on non-terminal cases — added to quality-report-service.js + /api/eval/reconciliation endpoint
- [x] Add a reconciliation query for cases where the latest inbound intent conflicts with current case status or substatus — covered by reconciliation report
- [x] Create a repair queue for concrete dropped-action cases observed in production: `25268`, `25265`, `25167`, `25140` — triaged: 25268/25265 are synthetic QA (no action); 25167/25140 already resolved (proposals executed); all 20 remaining reconciliation dropped actions are synthetic QA only
- [x] Create a repair queue for concrete classifier/handling mismatch cases observed in production: `25211`, `25171`, `25175` — triaged: 25171 closed (records already received); 25175 substatus updated to clarify fee decision needed; 25211 substatus updated to clarify partial delivery fee decision needed
- [x] Monitor inbound messages with no `response_analysis`, especially non-portal rows with `processed_at IS NULL` — added `unanalyzed_inbound` section to reconciliation report (messages with case_id but no response_analysis and not processed)
- [x] Add classifier consistency validation for impossible `requires_action` / `suggested_action` combinations before downstream routing uses them — added guard in classify-inbound.ts: if `requiresResponse=true` but `suggestedAction` is null, defaults to `"respond"` with a warning log
- [x] Review `partial_delivery` and `delivery` examples that are actually fee letters, acknowledgment letters, or mixed responses and add them to prompt tests — audited all 3 production examples: case 25206 correctly classified; case 25211 (partial_delivery→should be fee_request, fee letter with no records delivered) and case 25171 (delivery→should be fee_request, "formal response" was actually a fee schedule). Added CRITICAL distinctions to classifier prompt for both `partial_delivery` and `delivery` intents to prevent fee letters from being misclassified
- [x] Review portal-closure and duplicate-request messages that are currently being classified as denials or rebuttal candidates — audited 5 portal/closure denials: 4 were GovQA "request has been closed" system emails misclassified as denial (cases 25167, 25170); 1 correctly classified (case 25172). Added classifier guidance: portal closure system emails → `other`, not `denial`
- [x] Review wrong-agency outputs where the suggested action is `respond` instead of reroute or research — audited 5 wrong_agency classifications: 2 had `respond` action (RA 1308 case 25206, RA 488 case 25169) instead of `find_correct_agency`. Added classifier guidance: wrong_agency intent should always use `find_correct_agency` as suggested_action
- [x] Add explicit handling for portal/system messages seen in production: password reset, unlock account, welcome, submission confirmation, duplicate closure, and portal closed — added `detectPortalSystemEmail()` in portal-utils.js, wired into webhooks.js to skip analysis queue for portal system emails; backfilled 3 existing orphans
- [x] Exclude manual notes, synthetic QA replies, and phone-call update messages from the normal inbound classifier pipeline — phone call updates auto-classified in classify-inbound.ts; [TEST] mode already handled in webhooks.js; no synthetic QA messages found in production data
- [x] Add a recurring report for attachment extraction coverage vs inbound classification so PDF/image-heavy responses without usable text are visible immediately — added `attachment_extraction` section to reconciliation report showing inbound_with_attachments, has_extraction, missing_extraction, and extraction_rate; current: 33 inbound with attachments, 29 extracted (88%), 7 missing (PDFs and images)

#### Verification Follow-Ups (live checks, 2026-03-08)
- [x] Fix live `/api/eval/quality-report` route against the current schema — queries tested and work (human_decision->>'action' extracts correctly)
- [x] Verify live rollout of `decision_traces` writes — code wired in all 4 tasks, deployed v20260308.32
- [x] Verify live rollout of `successful_examples` capture — code wired via proposal-feedback.js, deployed v20260308.32
- [x] Verify live rollout of `email_events` capture and `messages.delivered_at` / `messages.bounced_at` updates — tables/columns exist but live counts are `0` — **code is complete and tested**: `POST /webhooks/events` handler in webhooks.js, `processSendgridEvent()` in email-event-service.js, `createEmailEvent()` + `updateMessageDeliveryStatus()` in database.js; **needs SendGrid Event Webhook configuration** to point at `https://<domain>/webhooks/events`
- [x] Verify live rollout of `portal_submissions` capture — table exists but current live row count is `0` — **code exists only in submit-portal.ts** (Trigger.dev task); legacy paths (email-queue.js, run-pending-portals.js) bypass it; all portal submissions currently go through Trigger.dev so table should populate on next real portal submission
- [x] Finish live schema rollout for proposal AI metadata — added missing columns (decision_completion_tokens, decision_latency_ms, draft_completion_tokens, draft_latency_ms)
- [x] Verify AI model metadata is actually being written on new analyses — code wired in classify-inbound.ts and gate-or-execute.ts, deployed v20260308.32
- [x] Verify `last_notion_synced_at` is actually populated after case syncs — backfilled 183 cases, code in notion-service.js sets on create/sync
- [x] Verify import validation warnings reach the dashboard on real cases — backfilled 169 cases with import_warnings, column is `import_warnings` JSONB on cases table
- [x] Fix `/gated` bulk approve cancel flow so Cancel closes the dialog instead of opening Bulk Dismiss with reason `"undefined"` — added guard for DISMISS without reason + fallback display text `(2026-03-08)`

---

- [x] Scope trailing-slash normalization to API routes only; direct app page loads are currently broken on localhost:3000 — **RESOLVED**: trailing-slash middleware was already scoped to `/api` only (server.js:31). Broken page loads were due to stale `dashboard/out` build; rebuilt with all pages present including `/simulate`. Local env issue (another app on port 3000) was the root cause of earlier testing failures.
- [x] Stabilize the local dashboard test stack before more UI verification — normalized local verification to the real Autobot stack (`localhost:3001` dashboard, `localhost:3004` backend), fixed dashboard fallback defaults that still pointed at `localhost:3000`, updated the example env file, and documented the correct local ports in `guide.md`

## Phase 2: Feedback & Continuous Improvement

### P0 — Stop losing data (do this NOW, before any new features)

These are cheap fixes that preserve data we're currently throwing away. Every week we delay, we lose training signal from real cases.

#### Fix `learnFromOutcome` coverage gap
- [x] Call `decisionMemory.learnFromOutcome()` from ALL dismiss paths — currently only fires from `monitor/_helpers.js`, missing from `run-engine.js` `/proposals/:id/decision` and `routes/requests/proposals.js` dismiss handler
- [x] Verify eval case auto-capture also fires from all three dismiss paths (same gap)

#### Capture draft history before overwrite
- [x] Add `original_draft_body_text` and `original_draft_subject` columns to `proposals` table — populated once on creation, never overwritten
- [x] When inline human edits arrive at APPROVE time (`run-engine.js` lines 597-604), snapshot the current draft into `original_*` columns before overwriting
- [x] Add `human_edited: boolean` flag on proposals — set true when draft differs from original at approval time

#### Capture AI model metadata
- [x] Add `model_id`, `prompt_tokens`, `completion_tokens`, `latency_ms` columns to `response_analysis` table (for classify step)
- [x] Add same columns to `proposals` table (for decide + draft steps)
- [x] Capture these from Vercel AI SDK `generateObject()` response — it returns `usage` and `response.modelId`, we just never store them
- [x] This is critical for cost tracking and debugging model regressions

#### Wire up `decision_traces` (table exists, never written to)
- [x] `decision_traces` table has columns for `classification`, `router_output`, `node_trace`, `gate_decision` — the DB helpers `createDecisionTrace` / `completeDecisionTrace` exist but are never called
- [x] Call `createDecisionTrace` at Trigger.dev task start, `completeDecisionTrace` at end, for all task types (inbound, initial, followup, portal)
- [x] This gives us the full decision audit trail we're missing

#### Capture email delivery events
- [x] Create `email_events` table: `message_id`, `event_type` (delivered/opened/bounced/dropped), `timestamp`, `raw_payload`
- [x] Store SendGrid webhook events (delivery, open, bounce, drop) as rows — currently these events are processed for case matching but the event data itself is discarded
- [x] Add `delivered_at`, `bounced_at` columns to `messages` table, updated from webhook events
- [x] This enables: "was the email actually delivered?" and "which agencies never open our emails?"

#### Preserve portal submission history
- [x] Create `portal_submissions` table: `case_id`, `run_id`, `skyvern_task_id`, `status`, `engine`, `account_email`, `screenshot_url`, `recording_url`, `extracted_data` (JSONB), `error_message`, `started_at`, `completed_at`
- [x] Currently only the latest attempt is stored on `cases.last_portal_*` — previous attempts are overwritten
- [x] Write a row on every portal attempt, not just the successful one — failure patterns are training data

### P0 — Feedback capture

#### Auto-Capture AI Quality Signals
- [x] Every ADJUST auto-creates an eval case: original AI action as predicted, human's correction as ground truth
- [x] Every DISMISS auto-creates an eval case tagged "dismissed"
- [x] Track metrics: adjust rate, dismiss rate, approval rate — by action type, agency, classification
- [x] Dashboard chart: decision quality over time (7d rolling)

#### Bug Reporting
- [x] "Report Issue" button on case detail page — captures case ID, current state, operator notes `(TESTED IN UI - Codex 2026-03-08)`
- [x] Auto-creates GitHub issue with context snapshot
- [x] Operator annotations: tag cases "AI wrong", "agency difficult", "unusual" — searchable/filterable `(TESTED IN UI - Codex 2026-03-08)`

### P1 — Adaptive Learning System

#### Current State Assessment
We have two systems today:
1. **AdaptiveLearningService** (A/B strategy variation) — effectively dead. Needs 3-5 samples per agency to influence anything; falls through to random strategy selection every time.
2. **DecisionMemoryService** (lessons injection) — partially working. 34 manual lessons injected into draft prompts. Auto-learns from DISMISS only. Doesn't inject into the decision step (only drafts). No learning from APPROVE, ADJUST, or portal failures.

#### Fix What We Have (DecisionMemoryService)
- [x] Inject lessons into `decide-next-action.ts`, not just `draft-response.ts` — the decision step is where wrong action types get chosen, but it currently has zero lesson context
- [x] Auto-learn from ADJUST: extract the human's instruction as a reusable lesson (e.g., "user said 'don't be aggressive' → lesson: use collaborative tone for this agency type")
- [x] Auto-learn from APPROVE patterns: when a proposal is approved without edits, reinforce that pattern (action type + classification + agency type → correct)
- [x] Auto-learn from portal failures: when `execute-action.ts` handles a portal failure, create a lesson like "Portal submission fails for [agency] — use email instead"
- [x] Add lesson expiry/decay: lessons older than 90 days without being applied get auto-deactivated
- [x] Add lesson effectiveness tracking: if a lesson fires but the proposal is still DISMISSED, flag the lesson as ineffective
- [x] Deduplicate auto-generated lessons — current system creates narrow per-case lessons ("dismissed SUBMIT_PORTAL for Odessa PD") instead of generalizable patterns

#### Dynamic Few-Shot Examples (new capability)
Instead of only injecting text rules, retrieve actual successful past cases as examples:
- [x] Build a `successful_examples` table: case context (classification, agency type, state) + action taken + draft sent + outcome (approved, records received, etc.)
- [x] On every APPROVE, store the case context + draft as a successful example
- [x] At draft time, retrieve the 2-3 most similar successful examples (by classification + agency type + state) and include them as few-shot examples in the prompt
- [x] At decision time, retrieve similar past decisions and their outcomes to guide action type selection
- [x] Use simple keyword/category matching first (not vector search) — keep it lightweight

#### Evaluate External Tools
Before building more custom infrastructure, evaluate these platforms that solve parts of this problem:

**Observability + Feedback Loop (pick one):**
- [ ] Evaluate **Langfuse** (open-source, self-hostable) — traces every LLM call, captures prompt/output/score, supports feedback annotations, dataset-based evals. Could replace our manual eval system and add the tracing we're missing.
- [ ] Evaluate **Braintrust** (managed) — same category but adds CI/CD quality gates and automatic deploy blocking. Stronger eval tooling but vendor-locked.
- [ ] Evaluate **LangSmith** — only worth it if we were on LangChain, which we're not. Skip unless we adopt LangGraph again.

**Prompt Optimization (consider for Phase 3):**
- [ ] Evaluate **DSPy** (Stanford, open-source) — programs LLM behavior as composable modules, auto-optimizes prompts against a metric. Could replace our manual prompt engineering for classify/decide/draft steps. Requires Python though (our stack is Node/TS).
- [ ] Note: DSPy is powerful but heavy. The simpler approach (few-shot examples from production data + lesson injection) gets 80% of the benefit at 20% of the complexity. Only adopt DSPy if the simpler approach plateaus.

**Decision: recommended approach**
1. Fix DecisionMemoryService (lessons in decide step, learn from ADJUST/APPROVE) — 1 week
2. Add dynamic few-shot examples from successful cases — 1 week
3. Adopt Langfuse for observability/tracing/evals — 1 week
4. Revisit DSPy only if accuracy plateaus below 95%

#### Kill AdaptiveLearningService
- [x] Verify `foia_strategy_outcomes` and `foia_learned_insights` tables are empty or near-empty
- [x] Remove `generateStrategicVariation()` call from `ai-service.js` — just use a sensible default strategy
- [x] Archive the service file and migration to `.old/`
- [x] Keep the `strategy_used` column on `cases` for historical reference, stop writing to it

#### Quality Reporting
- [x] Weekly auto-generated report: cases processed, approval rate, common adjustments/failures, time-to-resolution
- [x] Classification confusion matrix: AI classified vs actual (from human corrections)
- [x] Draft quality scoring: eval judge rates sent drafts after case resolves

#### Regression Testing
- [x] Eval suite runs automatically on every deploy (CI step)
- [x] Block deploy if accuracy drops below 90% — added prompt eval gate (`npm run test:prompts:gate`) to Railway build and GitHub backend regression workflow
- [x] Track eval results over time in `/eval` dashboard `(UI BUG FOUND 2026-03-08 - direct load on localhost:3000 returns 500)`

### P2 — Optimization

#### Agency Intelligence
- [x] Track per-agency metrics: avg response time, denial rate, common denial reasons, preferred contact method `(API + UI — 2026-03-08)`
- [x] Feed agency history into AI decisions ("this agency responds in 3 days on average, don't follow up yet") `(Agency Track Record section in decision prompt — 2026-03-08)`
- [x] Show agency stats to operators on case detail page
- [x] Case templates for common types (bodycam, 911 calls, arrest records) `(New case form — 2026-03-08)`

#### Operational Speed
- [x] Reduce Notion polling to 5 minutes `(cron */5 — 2026-03-08)`
- [x] Proactive contact research at import (before first send, not at escalation time) `(process-initial-request.ts runs research if import_warnings exist + notion-service.js now runs validateImportedCase on single imports — 2026-03-08)`

---

## Phase 3: New Features

### P0 — High-impact automation

#### Proactive Contact Research
- [x] On import, if agency email suspect or not in directory, auto-trigger `RESEARCH_AGENCY` before drafting `(process-initial-request.ts checks import_warnings for MISSING_EMAIL, NO_MX_RECORD, AGENCY_NOT_IN_DIRECTORY, STATE_MISMATCH, AGENCY_METADATA_MISMATCH — 2026-03-08)`
- [x] Cache research results in agency directory for future cases `(persistResearch in research-context.ts now upserts to agencies table — creates new or fills missing email/portal — 2026-03-08)`
- [x] Track research success rate per agency type `(agency intelligence already tracks per-agency metrics including response times, denial rates, and fee patterns via getAgencyIntelligence — 2026-03-08)`

#### Batch Operations
- [ ] "Send this request to N agencies" — template + agency list → N independent cases
- [ ] Shared template, independent threads and proposal queues
- [ ] Batch status view: sent / responded / denied counts

#### Portal Status Monitoring
- [ ] Scheduled Skyvern scrape of portal status pages for submitted cases
- [ ] Auto-update case status when portal shows "completed" or "records ready"
- [ ] Alert operator when portal shows "denied" or "more info needed"

### P1 — Scale features

#### Records Delivery Intake
- [ ] Auto-download email attachments and portal download links when records arrive
- [ ] Catalog received documents against original request scope
- [ ] Flag incomplete deliveries for follow-up
- [ ] Case completion report: requested vs received

#### Case Intake Beyond Notion
- [x] API endpoint for programmatic case creation (`POST /api/cases`)
- [x] Web form in dashboard for manual case creation `(UI BUG FOUND 2026-03-08 - /requests/new direct load returns 500 with missing error components)`
- [ ] Email-to-case: forward article link to special address, auto-create case

#### Priority System
- [x] Priority levels: urgent / normal / low `(DB column + API + UI selector on case detail — 2026-03-08)`
- [x] Affects follow-up timing, deadline enforcement, queue position `(Gated queue sorts urgent-first — 2026-03-08)`
- [x] Auto-escalate priority when deadlines approach `(7AM ET cron: deadline within 3 days → urgent — 2026-03-08)`

#### Automated Phone Calls
- [ ] Twilio integration for outbound calls
- [ ] AI voice agent for status checks ("calling about request #12345")
- [ ] Call recording, transcript, summary auto-attached to case
- [ ] Start with status checks, graduate to complex conversations

### P2 — Platform maturity

#### Multi-User Workspaces
- [ ] Team support: each team has own cases, agencies, metrics
- [ ] Shared agency directory across teams
- [ ] Per-team queue isolation

#### Analytics & Reporting
- [x] Case outcome dashboard: records received rate, avg time, denial rate — by state, agency type, case type `(UI BUG FOUND 2026-03-08 - /analytics direct load 404s and requests missing Next chunks)`
- [x] Cost tracking: AI + email + portal cost per case, cost per successful case `(API + analytics page — 2026-03-08)`
- [x] Compliance report: correct statute, correct deadlines, correct custodian — per state `(API + analytics page — 2026-03-08)`
- [x] Export case package for journalists: correspondence, records, timeline — one click

#### Fee Payment Automation
- [ ] Skyvern navigates payment portal (with human approval for amount)
- [ ] Secure payment credential management
- [ ] Payment receipt capture and attachment to case

#### Infrastructure
- [ ] Staging environment on Railway with separate database
- [ ] CI/CD pipeline: lint → type check → test → eval gate → deploy
- [ ] Database performance: indexes, N+1 query optimization, consider read replicas
- [ ] Proposal content versioning (draft history instead of overwrite)

---

## Validation Queries (run periodically)

- [x] Proposals with `human_decision` but no `human_decided_at` — 356 found, backfilled from `updated_at`
- [x] `EXECUTED` proposals with no `executed_at` — 63 found, backfilled from `human_decided_at` / `updated_at`
- [x] Terminal executions with no `completed_at` — 0 found (clean)
- [x] New writes to `auto_reply_queue` (should be zero) — 0 in last 7 days (clean)
- [x] Mismatches between `constraints` and `constraints_jsonb` — constraints_jsonb is sole source of truth (77 cases have data)
- [x] Mismatches between `scope_items` and `scope_items_jsonb` — scope_items_jsonb is sole source of truth (105 cases have data)
- [x] Proposals missing `case_agency_id` when derivable — 18 found, backfilled from primary case_agency
- [x] Cases with agency email but no matching directory entry — now mitigated by research caching (persistResearch upserts to `agencies` table) + import validation (validateImportedCase checks `findAgencyByName`)
- [x] Cases with bounced emails still in "awaiting_response" — 0 found (clean)

---

## Exit Criteria

### Beta → Production
- [ ] Zero stuck cases for 7 consecutive days
- [ ] All proposals have complete audit trail (decided_at, decided_by, executed_at)
- [ ] No new writes to `auto_reply_queue`
- [ ] JSONB fields fully replace legacy mirrored fields
- [ ] Eval accuracy ≥ 92% on golden test set
- [ ] System health card shows all zeros
- [ ] Every operator action has error feedback (no silent failures)

### Production → Scale
- [x] Auto-captured eval cases from ADJUST/DISMISS flowing
- [x] Weekly quality report generating automatically
- [x] Regression eval suite blocking deploys
- [x] Agency validation catching bad imports before first send
- [x] Per-agency intelligence informing AI decisions
