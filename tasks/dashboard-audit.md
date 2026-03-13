# Dashboard UI + AI Audit — Todo List

Created: 2026-03-13
Source: Full-page Playwright screenshot audit + AI quality analysis

---

## P0 — Critical Bugs

- [x] **Queue: Raw HTML leaking in inbound email display**
  - Enhanced `stripHtmlTags()` in utils.ts to handle br, p, a, em + entity decoding
  - `cleanEmailBody()` now strips HTML before splitting quoted threads

- [x] **Cases page: Total failure with no recovery**
  - Added retry button with RefreshCw icon and human-friendly timeout message
  - Added `errorRetryCount: 2` to SWR config for automatic retry

- [x] **Queue: Raw system errors exposed to operators**
  - Added `humanizeSubstatus()` to utils.ts — maps 429, timeout, agent failures to readable messages
  - Applied to all 3 substatus display locations in gated/page.tsx

---

## P1 — AI Handoff Quality (Biggest AI Weakness)

- [x] **Queue: Add structured AI summary to each proposal card**
  - Added "AI Summary" panel to both proposal and human review detail views
  - Shows: decision + confidence, top reason, status (humanized), risk flags, next step guidance
  - Blue-themed for proposals, purple-themed for human review cards

- [x] **Case Detail: Add AI decision summary panel**
  - Added compact AI Decision Bar between tags and main body (shows when case is paused)
  - Displays: action taken, confidence %, top reasoning, outcome status
  - Uses latest agent_decisions data from workspace API

- [x] **Humanize all status/substatus text across Queue and Case Detail**
  - Created `humanizeSubstatus()` in utils.ts — shared utility for all status text
  - Applied across Queue page (proposals + human review + phone tasks)

---

## P2 — Reliability & Error Handling

- [ ] **Cases page: Add loading skeleton instead of "Loading..." text**
  - All pages show plain "Loading..." — replace with skeleton/shimmer UI
  - Apply globally across all dashboard pages

- [ ] **Cases page: Add auto-retry with backoff on timeout**
  - 15s timeout is too aggressive for large case lists
  - Add retry logic with exponential backoff + manual retry button

- [ ] **Global: Add error boundaries with recovery actions**
  - Wrap major page sections in error boundaries
  - Show "Something went wrong" with retry, not blank screens

---

## P3 — AI Monitoring & Model Quality

- [ ] **Analytics: Add AI quality metrics section**
  - Missing: acceptance rate, bad draft rate, escalation reasons, provider/model comparison
  - Add: "AI Performance" panel with approval rate, rejection rate, average confidence, common failure modes
  - Track which workflows are degrading over time

- [ ] **Runs: Add AI outcome context to each run row**
  - Current: just status + case name
  - Add: decision made, confidence, whether proposal was accepted/rejected/adjusted, model used

- [ ] **Eval: Add summary stats + pagination**
  - Current: endless scroll of evaluations with no hierarchy
  - Add: summary bar (pass rate, fail rate, trending), pagination, filter by result

- [ ] **Worker Monitor: Add AI outcome context**
  - Current: only shows worker alive/dead status
  - Add: success rate, average confidence, error rate per worker

---

## P4 — Learning Loop (Lessons & Examples)

- [ ] **Lessons: Add value indicators and categorization**
  - Current: flat wall of lesson cards, all look identical
  - Add: category tags, impact score (how many cases affected), staleness indicator
  - Add: search/filter, sort by impact or recency
  - Show which lessons are actively shaping model behavior vs archived

- [ ] **Examples: Populate Classification column or remove it**
  - 11/12 examples show "N/A" for Classification — column adds no value
  - Either backfill classification data or hide when mostly empty

- [ ] **Examples: Add quality indicators**
  - Show: was this example used in recent prompts, how many times, success rate when used
  - Mark stale examples that haven't been relevant in 30+ days

---

## P5 — Agency Intelligence

- [ ] **Agencies: Surface operational signals**
  - Current: dense directory with name, email, state — no AI intelligence
  - Add columns/badges: automation fit (portal/email/manual), portal difficulty, denial tendency, sensitivity risk
  - Add: recommended strategy per agency, success rate, average response time

- [ ] **Agencies: Improve search and filtering**
  - Make search bar sticky/prominent at top
  - Add filters: by state, by automation type, by success rate, by portal status

---

## P6 — Simulator Improvements

- [ ] **Simulate: Add structured output display**
  - Current: runs scenarios but doesn't emphasize evidence, confidence, or scoring
  - Add: confidence score, rubric-based scoring, evidence citations
  - Add: side-by-side "expected vs actual" comparison for debugging
  - Show decision trace and reasoning chain

- [x] **Simulate: Improve empty state**
  - Added informative centered empty state with pipeline flow diagram (Classify → Decide → Draft)
  - Explains what the simulator does and that no side effects occur

---

## P7 — Settings & Operator Control

- [ ] **Settings: Expand AI policy controls**
  - Current: only Supervised toggle (which is ambiguous — OFF state unclear)
  - Fix toggle labeling: show explicit "Mode: Supervised" or "Mode: Autopilot"
  - Add: confidence threshold for auto-approval, model preference, escalation rules
  - Add: per-action-type controls (auto-approve followups but gate initial requests)

- [ ] **Onboarding: Add AI failure modes and intervention guidance**
  - Current: explains happy path only
  - Add: "When AI fails" section — common failure modes, when to intervene
  - Add: what Supervised mode actually changes in practice (with examples)

---

## P8 — Feedback & Bug Reporting

- [ ] **Feedback: Auto-attach AI context**
  - Current: generic bug form with no AI awareness
  - Auto-populate: model/provider used, prompt path, decision trace ID, confidence score, failure category, linked run ID
  - Make it easy for operators to file AI-specific feedback without manual context gathering

- [x] **Bug report floating button: Fix overlap on table pages**
  - Made button smaller (h-9 w-9), semi-transparent (opacity-60) until hover, slightly more offset (bottom-6 right-6)

---

## P9 — Frontend Polish

- [x] **Nav: Fix "ADM" truncation — should show "ADMIN"**
  - Added `shrink-0` to dropdown trigger so it can't be compressed by flex overflow

- [x] **Queue: Add confirmation dialog for WITHDRAW (destructive action)**
  - Added window.confirm() before both WITHDRAW buttons in gated/page.tsx

- [x] **Queue: Collapse secondary sections by default**
  - Inbound text now collapsed by default (Recent Actions was already collapsed)
  - "Why" section keeps first reasoning point visible, collapses rest

- [x] **Errors: Add severity indicators and grouping**
  - Added severity classification (critical/warning/info) with color-coded dots and row borders
  - Added clickable severity summary bar for filtering
  - Classification based on error name, code, message, and service

- [x] **Reconciliation: Sort by severity/count**
  - Section cards now sorted by count descending — highest-count issues surface first

- [x] **Admin: Make stat cards clickable for drill-down**
  - StatCard now accepts optional `href` prop with hover styling
  - "Active Cases" links to /requests, "Needs Review" links to /gated

- [ ] **Case Detail: Clarify "Submission Required" badge**
  - Unclear what submission is required or where to act
  - Add tooltip or inline explanation

- [x] **Changelog: Show current version indicator**
  - Added green "Current" badge next to the running version on changelog page

- [x] **Global: Replace "Loading..." with skeleton UI**
  - Replaced auth-gate loading with skeleton nav + stat cards + content blocks
  - Skeleton components already existed in loading-skeleton.tsx

- [ ] **Global: Add breadcrumbs on detail pages**
  - Case detail has back arrow but no breadcrumb trail
  - Queue → Case → Thread navigation loses context

---

## Leverage Point

**Reconciliation is the best screen for AI improvement targeting.** It already shows the most actionable weak spots: Blocked Import Cases (15), Processing Errors (4), Runs Without Traces (1), Attachment Extraction (12), Review Backlog (34). These are the clearest concrete AI improvement buckets. Consider making Reconciliation the default "AI Health" dashboard or linking it from the main nav more prominently.
