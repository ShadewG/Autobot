# Root Script Audit

Follow-up audit after the first two root cleanup batches on 2026-03-08.

## Archived To `.old/root-scripts`

The following root helpers had no active runtime, route, package-script, or external doc references after excluding cleanup docs, so they were moved into `.old/root-scripts`:

- `cancel-case-42.py`
- `check-all-notion-cases.js`, `check-case-56.js`, `check-database-name.js`, `check-message-85-analysis.js`, `check-non-empty-pages.js`, `check-properties.js`, `check-property-type.js`, `check-specific-page.js`
- `clear-cases.js`, `clear-queue-and-sample.js`, `complete-reset.js`
- `debug-notion-query.js`, `delete-test-cases.js`
- `fetch-notion-portals.js`, `find-live-status.js`
- `fix-case-42-portal.js`, `fix-states.js`
- `generate-samples.js`, `interactive-chat.js`, `query_25206.js`
- `regen-last-3.js`, `resend-case.js`, `reset-and-resync.js`, `retrigger-case-22.js`
- `run-migration-007.js`
- `send-clean-test.sh`, `send-test-both.sh`, `send-test-now.sh`
- `test-authenticated-domain.sh`, `test-case-56-contact.js`, `test-clean-domains.sh`, `test-complete-flow.js`, `test-contact-extraction.js`, `test-denial-rebuttal-standalone.js`, `test-denial-rebuttals-with-research.js`, `test-denial-rebuttals.js`, `test-full-conversation.js`, `test-full-gpt5-correspondence.js`, `test-gpt5-generation.js`, `test-gpt5-legal-research.js`, `test-inbound-flow.js`, `test-inbound-reply.js`, `test-instant-autoreply.js`, `test-live-status-query.js`, `test-normalize.js`, `test-notion-case.js`, `test-notion-simple.js`, `test-portals-bulk.js`, `test-process-reply.js`, `test-real-case-flow.js`, `test-real-portal.js`, `test-send-email.js`, `test-send-from-domain.js`, `test-sendgrid-curl.sh`, `test-sendgrid-direct.js`, `test-sendgrid.js`, `test-status-updates.js`, `test-stuck-detector.js`, `test-worker-status.js`
- `trigger-analysis-42.js`

## Remaining At Repo Root On Purpose

These files still have live references or are plausibly active enough that they should not be moved blindly:

### Referenced by docs or workflows

- `run-migration.js`
  - referenced by `AGENT_SETUP.md`
  - referenced by `AGENT_TESTING_GUIDE.md`
- `run-pending-portals.js`
  - referenced by `tasks/codex2-backend.md`
- `run-portal-test.command`, `run-portal-hyperbrowser.command`, `run-portal-managed.command`, `run-portal-skyvern.command`
  - referenced heavily by `PORTAL-AUTOMATION-README.md`
  - `run-portal-test.command` also referenced by `BRANCHING-STRATEGY.md` and `PORTAL-AGENT-README.md`
- `test-portal-agent.js`, `test-portal-hyperbrowser.js`, `test-portal-managed.js`, `test-portal-skyvern.js`
  - referenced by `PORTAL-AUTOMATION-README.md`
- `test-form.html`
  - referenced by `PORTAL-TESTING.md`
- `test-legal-research-only.js`
  - referenced by `docs/DENIAL-REBUTTAL-SYSTEM.md`

### Portal helper files that still need a coordinated cleanup

- `test-portal-agentkit.js`, `test-portal-local.js`
- `portal-agent-error-hyperbrowser.png`
- `portal-agent-log-hyperbrowser.json`
- `portal-agent-managed-log.json`
- `portal-agent-skyvern-log.json`
- `portal-error.png`
- `portal-filled.png`
- `portal-initial.png`

These are still tied to portal documentation and manual testing flows. If they move later, the docs need to be updated in the same pass.

## Recommended Next Cleanup Pass

1. Decide whether the portal test harness should stay root-level or move under `scripts/portal/`.
2. Update `PORTAL-AUTOMATION-README.md`, `PORTAL-AGENT-README.md`, `PORTAL-TESTING.md`, and `BRANCHING-STRATEGY.md` to the new paths.
3. Move the remaining portal test scripts, `.command` wrappers, and screenshot/log artifacts together in one coordinated change.
4. Decide whether `run-migration.js` and `run-pending-portals.js` deserve a permanent home under `scripts/active/` instead of the repo root.
