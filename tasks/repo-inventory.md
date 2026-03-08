# Autobot Repo Inventory

Initial top-level inventory for cleanup and archive planning. Scope is the repo root as it exists on 2026-03-08.

## Tag Legend

- `active`: part of the current runtime, build, test, or planning workflow
- `compat`: still present and possibly referenced, but should be reviewed before long-term retention
- `dev-only`: local setup, operator guidance, or developer support material
- `one-off`: ad hoc script or investigation entrypoint
- `archive-candidate`: artifact, report, screenshot, stale doc, or generated output that should likely move to `.old/` after validation

## Generated / Local-Only Paths

These top-level paths should not be curated as part of the long-term repo layout:

- `.git/`: Git metadata
- `node_modules/`: dependency install output
- `.next/`: dashboard build output
- `.trigger/`: Trigger.dev local output
- `.playwright-mcp/`: browser automation local output

## Top-Level Inventory

### `active`

- `.env.example`, `.gitignore`, `nixpacks.toml`, `package.json`, `package-lock.json`, `railway.json`, `server.js`
- `AGENTS.md`, `README.md`, `guide.md`
- `constants/`, `dashboard/`, `data/`, `database/`, `docs/`, `lib/`, `migrations/`, `prompts/`, `public/`, `queues/`, `routes/`, `scripts/`, `services/`, `tasks/`, `tests/`, `trigger/`, `utils/`
- `test-setup.js`: referenced by `package.json` as the supported setup/validation entrypoint

### `compat`

- `.railway-deploy`: deployment helper file that should be reviewed before cleanup
- `agentkit/`: alternate portal tooling path that may still be useful while portal provider selection is unresolved
- `LANGGRAPH_MIGRATION_PLAN.md`, `PORTAL-AGENT-README.md`, `PORTAL-AUTOMATION-README.md`, `PROJECT_STRUCTURE.md`
- `test/`: non-canonical test tree with legacy or duplicate material
- `workers/`: currently empty and needs a keep/archive decision

### `dev-only`

- `.claude/`, `.env`, `.env.test`, `.DS_Store`
- `AGENT_GUIDE.md`, `AGENT_SETUP.md`, `AGENT_TESTING_GUIDE.md`, `AI-BEHAVIOR.md`, `BRANCHING-STRATEGY.md`, `CLAUDE.md`, `DASHBOARD.md`, `QUICKSTART.md`, `RAILWAY_SETUP.md`, `TOTP_SETUP.md`, `PORTAL-TESTING.md`

### `one-off`

- `run-migration.js`, `run-pending-portals.js`
- `run-portal-agentkit.command`, `run-portal-hyperbrowser.command`, `run-portal-managed.command`, `run-portal-skyvern.command`, `run-portal-test.command`
- `test-form.html`, `test-legal-research-only.js`, `test-portal-agent.js`, `test-portal-agentkit.js`, `test-portal-hyperbrowser.js`, `test-portal-local.js`, `test-portal-managed.js`, `test-portal-skyvern.js`

## Moved To `.old/` On 2026-03-08

- `.old/docs/`: `AGENT_SIMULATION_TEST_RESULTS.md`, `PORTAL_AGENT_DEMO.md`, `PRODUCTION_READINESS_TEST_REPORT.md`, `TESTING-SUMMARY.md`, `test-case-19967-analysis.md`
- `.old/root-scripts/`: `cancel-case-42.py`, `check-all-notion-cases.js`, `check-case-56.js`, `check-database-name.js`, `check-message-85-analysis.js`, `check-non-empty-pages.js`, `check-properties.js`, `check-property-type.js`, `check-specific-page.js`, `clear-cases.js`, `clear-queue-and-sample.js`, `complete-reset.js`, `debug-notion-query.js`, `delete-test-cases.js`, `fetch-notion-portals.js`, `find-live-status.js`, `fix-case-42-portal.js`, `fix-states.js`, `generate-samples.js`, `interactive-chat.js`, `query_25206.js`, `regen-last-3.js`, `resend-case.js`, `reset-and-resync.js`, `retrigger-case-22.js`, `run-migration-007.js`, `send-clean-test.sh`, `send-test-both.sh`, `send-test-now.sh`, `test-authenticated-domain.sh`, `test-case-56-contact.js`, `test-clean-domains.sh`, `test-complete-flow.js`, `test-contact-extraction.js`, `test-denial-rebuttal-standalone.js`, `test-denial-rebuttals-with-research.js`, `test-denial-rebuttals.js`, `test-full-conversation.js`, `test-full-gpt5-correspondence.js`, `test-gpt5-generation.js`, `test-gpt5-legal-research.js`, `test-inbound-flow.js`, `test-inbound-reply.js`, `test-instant-autoreply.js`, `test-live-status-query.js`, `test-normalize.js`, `test-notion-case.js`, `test-notion-simple.js`, `test-portals-bulk.js`, `test-process-reply.js`, `test-real-case-flow.js`, `test-real-portal.js`, `test-send-email.js`, `test-send-from-domain.js`, `test-sendgrid-curl.sh`, `test-sendgrid-direct.js`, `test-sendgrid.js`, `test-status-updates.js`, `test-stuck-detector.js`, `test-worker-status.js`, `trigger-analysis-42.js`
- `.old/test-artifacts/`: `langgraph-test-report.json`, `portal-test-results.json`, `portal-run-results/`, `portal-agent-log-hyperbrowser.json`, `portal-agent-managed-log.json`, `portal-agent-skyvern-log.json`
- `.old/screenshots/`: `test-case-no-proposal.png`, `test-collapsed-control-center.png`, `test-expanded-control-center.png`, `test-expanded-no-proposal.png`, `portal-agent-error-hyperbrowser.png`, `portal-error.png`, `portal-filled.png`, `portal-initial.png`, `portal-screenshots-hyperbrowser/`

## Real Test Surface

These are the supported entrypoints that appear to be intentionally wired into the repo today:

- `npm test`: Mocha recursion over `tests/`
- `npm run test:chaos`: `tests/chaos/reliability.test.js`
- `npm run test:golden` and `npm run test:golden:update`: golden-case suite under `tests/golden-cases/`
- `npm run test:load`: `tests/load/staging-load-test.js`
- `npm run test:prompts`, `test:prompts:verbose`, `test:prompts:dry`: `scripts/test-prompt-suite.js`
- `npm run test:e2e:prompts`: `tests/e2e/api-prompt-e2e.test.js`
- `npm run test:prod-ready`, `test:prod-ready:full`, `test:contract`, `test:orchestration`, `test:idempotency`: `tests/e2e/production-readiness.test.js`
- `npm run test:golden:runner`: `tests/golden-runner.js`
- `cd dashboard && npm run lint`: canonical dashboard validation command

These appear non-canonical and should be treated as cleanup targets until proven otherwise:

- top-level `test-*` files in the repo root
- the separate top-level `test/` directory
- many `scripts/_test_*`, `_debug_*`, `_check_*`, `_fix_*`, and `_investigate_*` files currently showing up in the working tree

## Immediate Cleanup Guidance

- Keep runtime directories and package-script entrypoints in place.
- Prefer moving screenshot/report artifacts and root one-off files before touching compat paths.
- Do not archive `agentkit/` or the portal docs until portal ownership and actual runtime references are confirmed.
- Do not remove `workers/` yet: the directory is empty, but legacy tests and migration notes still reference `workers/agent-worker.js`.
