# Codex 2 — Backend: Routes, Services, Database, Cron, Notion Sync

**Scope**: Express routes, database layer, email/portal services, cron jobs, Notion sync, migrations.
**Files you own** (only edit these):

```
server.js
routes/run-engine.js
routes/eval.js
routes/requests/*.js
routes/api.js
routes/agencies.js
routes/monitor/*.js
services/database.js
services/executor-adapter.js
services/portal-agent-service-skyvern.js
services/cron-service.js
services/notion-sync-service.js
services/email-processor.js
queues/email-queue.js
run-pending-portals.js
migrations/*.sql
```

**DO NOT edit** (shared with Codex 1):
`trigger/` directory, `services/ai-service.js`, `services/decision-memory-service.js`, `services/adaptive-learning-service.js`.

---

## Tasks

### Phase 1 P0

#### Proposal Lifecycle Hardening
- [x] Centralize proposal human-review updates into one helper in `services/database.js`: approve, dismiss, withdraw, adjust all go through same path
- [x] Ensure every human review writes `human_decision`, `human_decided_at`, `human_decided_by`
- [x] Ensure every executed proposal writes `executed_at`
- [x] Ensure every terminal execution writes `completed_at`
- [x] Audit all direct `updateProposal()` callers in `routes/run-engine.js`, `routes/requests/proposals.js` and route through lifecycle helper
- [x] Stress-test waitpoint fallback paths (direct email, direct PDF email) — verify rollback on failure

#### Execution Completeness
- [x] Centralize execution terminal-state writes into one helper
- [x] Ensure every `SENT`, `FAILED`, `CANCELLED`, `PENDING_HUMAN` transition updates `updated_at`
- [x] Ensure email executions always write `provider_message_id`
- [x] Normalize `provider_payload` across direct-send, queued email, portal, and no-op executions
- [x] Verify email worker always calls final execution update path after success

#### Agency Validation at Import
- [x] On Notion import, validate agency email (format check + MX record lookup) in `services/notion-sync-service.js`
- [x] Check if agency exists in directory — flag if not found
- [x] Verify state matches agency state — flag mismatches
- [x] Run `detectCaseMetadataAgencyMismatch` at import time
- [x] Store validation warnings as `import_warnings` JSONB on case

#### Notion Sync Data Quality
- [ ] Fix "value too long" errors: truncate agency name to 255 chars, normalize state to 2-char code
- [ ] Skip Notion pages with no agency name (null name guard)
- [ ] Fix phone field overflow (varchar(50))
- [ ] Fix notes field overflow (varchar(1000) → TEXT or truncate)
- [ ] Prevent duplicate agency inserts for same `notion_page_id` (upsert instead of insert)

### Phase 1 P1

#### Data Quality & Schema Cleanup
- [ ] Make `constraints_jsonb` sole source of truth — backfill mismatches, update all reads in `database.js`, remove legacy `constraints`
- [ ] Make `scope_items_jsonb` sole source of truth — same process
- [ ] Inventory all writes to `auto_reply_queue` — replace with `proposals`, add compat adapter if needed
- [ ] Remove `cases.langgraph_thread_id` reliance
- [ ] Agency directory dedup: normalize names on insert, merge duplicates
- [ ] Remove `agent_runs.proposal_id` once all readers migrated to `proposals.run_id`

#### Portal Data Quality
- [ ] Ensure completed `portal_tasks` always write `completed_by` and `confirmation_number`
- [ ] Sync portal task completion back to `executions` and `proposals`
- [ ] Improve `portal_request_number` capture
- [ ] Add validation so portal cases without request number are identifiable

#### Notion Sync Reliability
- [ ] Root-cause recurring sync failures
- [x] Add `POST /api/notion/sync` endpoint for "Sync Now" button
- [x] Add `last_notion_synced_at` field to cases table, updated on each sync

#### New API Endpoints (for Claude 1 & 2 frontend work)
- [ ] `GET /api/health/summary` — system health metrics
- [ ] `POST /api/proposals/batch-decision` — bulk approve/dismiss
- [ ] `GET /api/requests?search=<query>` — full-text search
- [ ] `GET /api/cases/:id/timeline` — case event timeline
- [ ] `GET /api/cases/:id/decision-traces` — decision audit trail
- [ ] `DELETE /api/cases/:id/constraints/:tag` — remove constraint
- [ ] `POST /api/cases/:id/constraints` — add constraint
- [ ] `GET /api/agencies/:id/stats` — per-agency metrics
- [ ] `POST /api/issues` — create GitHub issue from bug report

### Phase 2 P0

#### Fix `learnFromOutcome` coverage gap
- [x] Call `decisionMemory.learnFromOutcome()` from ALL dismiss paths: `run-engine.js`, `routes/requests/proposals.js` (currently only fires from `monitor/_helpers.js`)
- [x] Verify eval case auto-capture fires from all three dismiss paths

#### Capture draft history before overwrite
- [x] Migration: add `original_draft_body_text`, `original_draft_subject`, `human_edited` columns to `proposals`
- [x] In `run-engine.js` approve handler: snapshot current draft before overwriting with human edits

#### Capture email delivery events
- [x] Migration: create `email_events` table
- [x] Store SendGrid webhook events as rows (currently processed but discarded)
- [x] Migration: add `delivered_at`, `bounced_at` to `messages` table
- [x] Update webhook handler to write event rows

#### Preserve portal submission history
- [x] Migration: create `portal_submissions` table
- [x] Write a row on every portal attempt in `portal-agent-service-skyvern.js`

### Phase 2 P1

#### Auto-Capture AI Quality Signals
- [x] On every ADJUST: auto-create eval case (original AI action as predicted, human correction as ground truth) in `run-engine.js`
- [x] On every DISMISS: auto-create eval case tagged "dismissed"
- [x] Track metrics: adjust rate, dismiss rate, approval rate by action type/agency/classification

#### Successful Examples Table
- [x] Migration: create `successful_examples` table
- [x] On every APPROVE in `run-engine.js`, store case context + draft as successful example

### Phase 2 P2

#### Agency Intelligence
- [ ] Track per-agency metrics: avg response time, denial rate, common denial reasons in `database.js`
- [ ] `GET /api/agencies/:id/stats` endpoint with computed metrics
- [ ] Feed agency history into case context (loaded by Trigger.dev `load-context.ts` — coordinate with Codex 1)

#### Daily Operator Digest
- [ ] Cron job: daily email summary of stuck cases, pending proposals > 48h, bounced emails, portal failures
- [ ] Use SendGrid for delivery

#### Future-Proof Data Capture
- [ ] Extend `case_event_ledger` or create unified append-only event stream
- [ ] Capture raw inbound/outbound provider payloads
- [ ] Add normalized failure metadata: `failure_stage`, `failure_code`, `retryable`, `retry_attempt`
