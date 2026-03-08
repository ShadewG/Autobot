# `.old/` Archive Manifest

Use this folder only for files that have already been verified as non-runtime and non-canonical.

## Subfolders

- `root-scripts/`: retired one-off scripts from the repo root
- `test-artifacts/`: JSON reports, generated test output, and temporary result files
- `legacy-routes/`: routes removed from active server mounts
- `legacy-services/`: retired service implementations kept for reference
- `docs/`: stale or superseded docs kept for historical context
- `screenshots/`: screenshots and image artifacts that are not part of product assets

## Move Rules

Before moving a file into `.old/`, verify all of the following:

1. It is not mounted in `server.js`.
2. It is not imported by an active route, service, or Trigger task.
3. It is not referenced by a root or dashboard `package.json` script.
4. It is not an active SQL migration or runtime asset.
5. A canonical replacement exists if the file used to document or test a still-active workflow.

If any of those checks fail or are unknown, do not move the file yet.

## Manifest Entry Format

Whenever a file or folder is moved into `.old/`, append an entry using this template:

```md
### <original path>
- moved_to: `.old/<subfolder>/<filename>`
- moved_on: `YYYY-MM-DD`
- reason: short explanation of why it was archived
- restore_note: what to check if it ever needs to be restored
```

## First Recommended Moves

- root screenshot and JSON artifact files
- root one-off `test-*`, `check-*`, `fix-*`, `reset-*`, `regen-*`, and `resend-*` scripts after reference checks
- stale report docs that have a newer canonical equivalent in `guide.md`, `tasks/repo-inventory.md`, or `tasks/runtime-reference.md`

## Moved Entries

### AGENT_SIMULATION_TEST_RESULTS.md
- moved_to: `.old/docs/AGENT_SIMULATION_TEST_RESULTS.md`
- moved_on: `2026-03-08`
- reason: superseded test report artifact at the repo root
- restore_note: restore only if a current doc needs to link to the original historical report

### PORTAL_AGENT_DEMO.md
- moved_to: `.old/docs/PORTAL_AGENT_DEMO.md`
- moved_on: `2026-03-08`
- reason: demo/reference artifact not needed at the repo root
- restore_note: restore only if portal demo instructions become part of the active onboarding flow

### PRODUCTION_READINESS_TEST_REPORT.md
- moved_to: `.old/docs/PRODUCTION_READINESS_TEST_REPORT.md`
- moved_on: `2026-03-08`
- reason: historical test report artifact
- restore_note: restore only if current release docs need the historical report in the root

### TESTING-SUMMARY.md
- moved_to: `.old/docs/TESTING-SUMMARY.md`
- moved_on: `2026-03-08`
- reason: historical summary doc better stored with archived docs
- restore_note: restore only if it becomes part of the active testing workflow

### test-case-19967-analysis.md
- moved_to: `.old/docs/test-case-19967-analysis.md`
- moved_on: `2026-03-08`
- reason: case-specific analysis artifact
- restore_note: restore only if case 19967 becomes an active regression fixture

### langgraph-test-report.json
- moved_to: `.old/test-artifacts/langgraph-test-report.json`
- moved_on: `2026-03-08`
- reason: generated report artifact
- restore_note: restore only if a current tool expects the root path specifically

### portal-test-results.json
- moved_to: `.old/test-artifacts/portal-test-results.json`
- moved_on: `2026-03-08`
- reason: generated portal test output
- restore_note: restore only if a current portal test harness expects the root path specifically

### portal-run-results
- moved_to: `.old/test-artifacts/portal-run-results`
- moved_on: `2026-03-08`
- reason: archived portal result directory with no active runtime references
- restore_note: restore only if portal result examples are needed for debugging or docs

### test-case-no-proposal.png
- moved_to: `.old/screenshots/test-case-no-proposal.png`
- moved_on: `2026-03-08`
- reason: screenshot artifact not used by runtime or package scripts
- restore_note: restore only if the screenshot is needed in active documentation

### test-collapsed-control-center.png
- moved_to: `.old/screenshots/test-collapsed-control-center.png`
- moved_on: `2026-03-08`
- reason: screenshot artifact not used by runtime or package scripts
- restore_note: restore only if the screenshot is needed in active documentation

### test-expanded-control-center.png
- moved_to: `.old/screenshots/test-expanded-control-center.png`
- moved_on: `2026-03-08`
- reason: screenshot artifact not used by runtime or package scripts
- restore_note: restore only if the screenshot is needed in active documentation

### test-expanded-no-proposal.png
- moved_to: `.old/screenshots/test-expanded-no-proposal.png`
- moved_on: `2026-03-08`
- reason: screenshot artifact not used by runtime or package scripts
- restore_note: restore only if the screenshot is needed in active documentation

### root one-off script batch
- moved_to: `.old/root-scripts/`
- moved_on: `2026-03-08`
- reason: large batch of unreferenced root-level check/fix/reset/test helpers with no active runtime, route, or package-script references
- restore_note: restore an individual file only if an active doc, script, or operator workflow is updated to depend on that exact path

Files in this batch:
`cancel-case-42.py`, `check-all-notion-cases.js`, `check-case-56.js`, `check-database-name.js`, `check-message-85-analysis.js`, `check-non-empty-pages.js`, `check-properties.js`, `check-property-type.js`, `check-specific-page.js`, `clear-cases.js`, `clear-queue-and-sample.js`, `complete-reset.js`, `debug-notion-query.js`, `delete-test-cases.js`, `fetch-notion-portals.js`, `find-live-status.js`, `fix-case-42-portal.js`, `fix-states.js`, `generate-samples.js`, `interactive-chat.js`, `query_25206.js`, `regen-last-3.js`, `resend-case.js`, `reset-and-resync.js`, `retrigger-case-22.js`, `run-migration-007.js`, `send-clean-test.sh`, `send-test-both.sh`, `send-test-now.sh`, `test-authenticated-domain.sh`, `test-case-56-contact.js`, `test-clean-domains.sh`, `test-complete-flow.js`, `test-contact-extraction.js`, `test-denial-rebuttal-standalone.js`, `test-denial-rebuttals-with-research.js`, `test-denial-rebuttals.js`, `test-full-conversation.js`, `test-full-gpt5-correspondence.js`, `test-gpt5-generation.js`, `test-gpt5-legal-research.js`, `test-inbound-flow.js`, `test-inbound-reply.js`, `test-instant-autoreply.js`, `test-live-status-query.js`, `test-normalize.js`, `test-notion-case.js`, `test-notion-simple.js`, `test-portals-bulk.js`, `test-process-reply.js`, `test-real-case-flow.js`, `test-real-portal.js`, `test-send-email.js`, `test-send-from-domain.js`, `test-sendgrid-curl.sh`, `test-sendgrid-direct.js`, `test-sendgrid.js`, `test-status-updates.js`, `test-stuck-detector.js`, `test-worker-status.js`, `trigger-analysis-42.js`

### portal artifact batch
- moved_to: `.old/test-artifacts/` and `.old/screenshots/`
- moved_on: `2026-03-08`
- reason: generated portal logs and screenshots were cluttering the repo root but are not required at fixed root paths
- restore_note: restore only if active docs or helper scripts are changed to require the historical artifact files in the repo root

Files in this batch:
`portal-agent-log-hyperbrowser.json`, `portal-agent-managed-log.json`, `portal-agent-skyvern-log.json`, `portal-agent-error-hyperbrowser.png`, `portal-error.png`, `portal-filled.png`, `portal-initial.png`, `portal-screenshots-hyperbrowser/`

### services/adaptive-learning-service.js
- moved_to: `.old/legacy-services/adaptive-learning-service.js`
- moved_on: `2026-03-08`
- reason: retired adaptive-learning implementation; runtime now uses decision memory plus successful examples instead
- restore_note: restore only if a future migration explicitly revives the old strategy-learning system and reintroduces runtime callers

### migrations/005_adaptive_learning_tables.sql
- moved_to: `.old/legacy-services/005_adaptive_learning_tables.sql`
- moved_on: `2026-03-08`
- reason: obsolete migration for adaptive-learning tables that are no longer present in production and no longer queried by runtime code
- restore_note: restore only if you intentionally need the legacy adaptive-learning schema for historical replay or a one-off data recovery task
