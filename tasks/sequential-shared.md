# Sequential — Shared Files & Cross-Cutting Work

**These items touch files shared by multiple workers or require coordination.**
Do NOT run these in parallel with any of the 4 workers. Run them one at a time, ideally between parallel work sessions.

---

## Shared Frontend Components (touched by both Claude 1 & Claude 2)

- [ ] `auth-provider.tsx` — any auth flow changes
- [ ] `thread.tsx` — used by `/gated` (Claude 1) and detail pages (Claude 2)
- [ ] `linkified-text.tsx` — used by `/gated` (Claude 1) and detail-v2 (Claude 2)
- [ ] `add-correspondence-dialog.tsx` — used by `/gated` (Claude 1) and detail pages (Claude 2)
- [ ] Any `dashboard/lib/` files: `api.ts`, `hooks/`, `utils.ts`, `types.ts`, `email-cleaner.ts`, `state-exemptions.ts`, `selectors/`
- [ ] Any `dashboard/components/ui/` files (shadcn primitives)

## Shared Backend Files (touched by both Codex 1 & Codex 2)

These files are imported by both AI pipeline code and route/service code:

- [ ] `services/database.js` — DB layer used everywhere. If Codex 1 needs new columns read, and Codex 2 needs new columns written, coordinate.
- [ ] `trigger/steps/load-context.ts` — loads case data for Trigger.dev tasks but reads from DB layer. If Codex 2 adds new fields to cases, Codex 1 may need to read them in load-context.

## Migrations (run one at a time, not in parallel)

All schema changes must be coordinated. Run migrations in order.

### For Codex 1 work:
- [ ] Add `model_id`, `prompt_tokens`, `completion_tokens`, `latency_ms` to `response_analysis` table
- [ ] Add `model_id`, `prompt_tokens`, `completion_tokens`, `latency_ms` to `proposals` table
- [ ] Create `successful_examples` table (if Codex 1 builds few-shot, Codex 2 writes on APPROVE)

### For Codex 2 work:
- [ ] Add `original_draft_body_text`, `original_draft_subject`, `human_edited` to `proposals`
- [ ] Create `email_events` table
- [ ] Add `delivered_at`, `bounced_at` to `messages`
- [ ] Create `portal_submissions` table
- [ ] Add `last_synced_at` to `cases`
- [ ] Add `agency_warnings` JSONB field to `cases`

### For both:
- [ ] Make `constraints_jsonb` sole source of truth (Codex 2 backfills + updates writes, Codex 1 updates reads in Trigger tasks)
- [ ] Make `scope_items_jsonb` sole source of truth (same split)

## Phase 0: Repo Cleanup (run solo, not in parallel)

This moves files around and can break imports for everyone. Do it in one session.

- [ ] Build file inventory: tag each file as `active`, `compat`, `dev-only`, `one-off`, or `archive-candidate`
- [ ] Create `.old/` folder structure
- [ ] Move loose root scripts into `scripts/` or `.old/`
- [ ] Move test artifacts and screenshots into `.old/`
- [ ] Consolidate tests under `tests/`
- [ ] Archive legacy routes/services after import verification
- [ ] Update `guide.md` after each batch

## Phase 3: New Features (run after Phases 1-2 complete)

These are too large for parallel work and require foundation from earlier phases:

- [ ] Batch operations: "send to N agencies"
- [ ] Portal status monitoring (scheduled Skyvern scrape)
- [ ] Records delivery intake (auto-download + catalog)
- [ ] Case intake API beyond Notion
- [ ] Priority system
- [ ] Automated phone calls (Twilio)
- [ ] Multi-user workspaces
- [ ] Fee payment automation
- [ ] Staging environment
- [ ] CI/CD pipeline with eval gate

## Coordination Notes

### When starting a parallel session:
1. Pull latest `main` before starting any worker
2. Each worker should commit frequently to minimize merge conflicts
3. If a worker needs a migration, write it but don't run it — add to the Sequential list
4. Frontend workers should not touch `dashboard/lib/` — if they need a new util, add it to Sequential

### Merge order when multiple workers finish:
1. Codex 2 first (routes/services/migrations — foundational)
2. Codex 1 second (AI pipeline — depends on DB schema from Codex 2)
3. Claude 1 third (list pages — may need new API endpoints from Codex 2)
4. Claude 2 last (detail pages — may need new API endpoints and new AI data)
