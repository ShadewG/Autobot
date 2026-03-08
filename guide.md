# Autobot Repo Guide

This is a working map of the repo so you can move through it in VS Code without guessing what matters. It is biased toward the currently mounted runtime paths, the active dashboard, and the Trigger.dev pipeline.

## Local Verification Stack

- `http://localhost:3001`: active Next.js dashboard for local UI checks.
- `http://localhost:3004`: active Express backend and API target for local dashboard traffic.
- `http://localhost:3000`: do not trust this for Autobot verification on this machine; another local app may already be bound there.
- `npm run dashboard:local`: serves the static dashboard locally and now proxies `/api/*` to `3004` by default.

## Start Here

- `server.js`: main Express entrypoint. Mounts backend routes, health check, SSE updates, migrations, cron jobs, and BullMQ workers.
- `services/database.js`: primary database access layer and the main place where schema behavior is encoded.
- `routes/run-engine.js`: central run/proposal lifecycle logic. If a case is being advanced, gated, approved, dismissed, or executed, check here early.
- `dashboard/`: Next.js operator UI.
- `trigger/`: Trigger.dev orchestration for inbound handling, drafting, gating, execution, and scheduling.
- `tasks/todo.md`: active tracker for cleanup, schema work, and product tasks.

## Suggested Review Order

- `server.js`
- `routes/requests.js`
- `routes/monitor.js`
- `routes/run-engine.js`
- `services/database.js`
- `services/executor-adapter.js`
- `services/sendgrid-service.js`
- `trigger/trigger.config.ts`
- `trigger/tasks/*`
- `dashboard/app/requests/*`

## Runtime Shape

- Express is the main backend runtime.
- The dashboard is a Next.js app in `dashboard/` and its static build is served by `server.js`.
- Trigger.dev handles the async decision pipeline and portal/background workflows.
- BullMQ workers in `queues/email-queue.js` handle email sending and portal jobs. All inbound classification routes through Trigger.dev (no legacy analysis worker).
- Most persistent state ends up flowing through `services/database.js`.

## Main Mounted Routes

- `routes/webhooks.js`: inbound webhook entrypoint, especially email/webhook ingestion.
- `routes/api.js`: dashboard API surface — Notion sync, KPIs, case processing, outcomes, costs, compliance.
- `routes/test.js`: dev/test route aggregator mounted at `/api/test`. Guarded behind `ENABLE_TEST_ROUTES=true` env var; returns 404 in production.
- `routes/requests.js`: request-focused API surface. One of the most important route aggregators.
- `routes/agencies.js`: agency directory endpoints.
- `routes/run-engine.js`: run actions, proposal decisions, execution flow.
- `routes/portal-tasks.js`: manual portal task tracking and review.
- `routes/shadow-mode.js`: shadow/review tracking and metrics.
- `routes/cases.js`: case import and case-level endpoints.
- `routes/monitor.js`: monitoring/debug views used by the dashboard and ops flows.
- `routes/phone-calls.js`: phone escalation queue.
- `routes/users.js`: user management.
- `routes/auth.js`: auth session endpoints.
- `routes/case-agencies.js`: multi-agency links per case.
- `routes/eval.js`: evaluation endpoints (quality report, classification confusion, reconciliation, errors).
- `routes/simulate.js`: dry-run simulator endpoints.
- `routes/admin.js`: admin-only controls.

## `routes/requests/*`

- `routes/requests/query.js`: request detail/list reads and lookup endpoints.
- `routes/requests/case-management.js`: request/case management actions (withdraw, reply, constraints, tags, priority, batch).
- `routes/requests/case-updates.js`: updates to case metadata and mutable case fields.
- `routes/requests/proposals.js`: proposal review, adjustment, and decision endpoints.
- `routes/requests/agent-control.js`: agent-control actions (reset, replay).
- `routes/requests/screenshots.js`: screenshot retrieval endpoints.
- `routes/requests/dlq-reaper.js`: DLQ/recovery tooling.
- `routes/requests/legacy-actions.js`: compatibility-heavy. Still required by dashboard `executeProposal` action.

## `routes/monitor/*`

- `routes/monitor/overview.js`: high-level operational summaries.
- `routes/monitor/system-health.js`: system health card metrics (stuck cases, orphaned runs, stale proposals, overdue deadlines, bounced emails, portal failures).
- `routes/monitor/inbound.js`: inbound email/request monitoring.
- `routes/monitor/outbound.js`: outbound send monitoring.
- `routes/monitor/cases.js`: case-level monitor views.
- `routes/monitor/proposals.js`: proposal queue/debug views.
- `routes/monitor/agent.js`: agent/run visibility.
- `routes/monitor/portal.js`: portal workflow monitoring.
- `routes/monitor/lessons.js`: learning/lesson visibility.
- `routes/monitor/events.js`: event stream/debug view.
- `routes/monitor/_helpers.js`: shared monitor helper logic.

## Service Layer

### Core Runtime

- `services/database.js`: core DB queries, lifecycle helpers, schema-adjacent logic.
- `services/case-runtime.js`: case state/runtime orchestration.
- `services/executor-adapter.js`: execution handoff and final execution status writes.
- `services/sendgrid-service.js`: outbound/inbound email integration behavior.
- `services/trigger-dispatch-service.js`: handoff into Trigger.dev flows.
- `services/dispatch-helper.js`: supporting dispatch logic.
- `services/cron-service.js`: scheduled sweeps, syncs, health checks, and cleanup jobs.
- `services/attachment-processor.js`: attachment extraction/processing.
- `services/storage-service.js`: storage-related helpers.
- `services/proposal-lifecycle.js`: centralized proposal state transitions (approve, dismiss, withdraw, adjust).
- `services/error-tracking-service.js`: persisted error event tracking.

### Portal Automation

- `services/portal-agent-service-skyvern.js`: active Skyvern portal submission provider.
- `services/portal-service.js`: shared portal-facing service logic (used by test endpoints).

Legacy portal variants (hyperbrowser, managed, agentkit, base) archived to `.old/legacy-services/`.

### AI & Decision

- `services/ai-service.js`: OpenAI/Anthropic API wrapper with fallback. Used for drafts and legacy analysis.
- `services/decision-memory-service.js`: decision memory/lesson injection into prompts.
- `services/decision-trace-service.js`: decision audit trail persistence.
- `services/successful-examples-service.js`: few-shot example retrieval from approved cases.
- `services/action-validator.js`: action type validation.
- `services/draft-quality-eval-service.js`: AI-judged draft quality scoring.
- `services/quality-report-service.js`: weekly quality reports and reconciliation.
- `services/proposal-draft-history.js`: proposal content versioning.
- `services/proposal-feedback.js`: proposal feedback capture.

### Agency / Notion / Research

- `services/notion-service.js`: Notion integration (import, sync, status updates).
- `services/agency-notion-sync.js`: agency sync flow from Notion.
- `services/canonical-agency.js`: agency normalization/canonicalization.
- `services/pd-contact-service.js`: public records contact lookup/support logic.

### Ops / Secondary

- `services/reaper-service.js`: stuck/orphan cleanup support.
- `services/shadow-mode.js`: shadow review support.
- `services/dashboard-service.js`: dashboard-facing helper logic.
- `services/notification-service.js`: notifications.
- `services/discord-service.js`: Discord operational notifications.
- `services/logger.js`: structured logging with agent context.
- `services/email-event-service.js`: SendGrid delivery event processing.
- `services/event-bus.js`: in-process event bus.
- `services/follow-up-service.js`: follow-up scheduling logic.
- `services/followup-scheduler.js`: follow-up timer management.
- `services/stuck-response-detector.js`: detect stuck response patterns.
- `services/pdf-form-service.js`: PDF form generation.

## Trigger.dev

- `trigger/trigger.config.ts`: Trigger.dev config, deployment env sync, task directories, retries.
- `trigger/lib/db.ts`: bridge from Trigger tasks into the existing JS service layer.
- `trigger/lib/types.ts`: shared types.
- `trigger/lib/schemas.ts`: task payload schemas and validation.
- `trigger/lib/ai.ts`: AI model configuration (GPT-5.2 with reasoning effort levels, Anthropic fallback).
- `trigger/lib/portal-utils.ts`: portal helpers used by tasks/steps.
- `trigger/lib/reconcile-case.ts`: case reconciliation helpers.
- `trigger/lib/text-sanitize.ts`: content cleanup/sanitization.

### Trigger Tasks

- `trigger/tasks/process-inbound.ts`: inbound email/request processing (all inbound routes here).
- `trigger/tasks/process-initial-request.ts`: initial request drafting/sending flow.
- `trigger/tasks/process-followup.ts`: follow-up workflow.
- `trigger/tasks/submit-portal.ts`: portal submission flow.
- `trigger/tasks/eval-decision.ts`: eval/judging flow.
- `trigger/tasks/simulate-decision.ts`: dry-run simulation.
- `trigger/tasks/health-check.ts`: task/runtime health check.

### Trigger Steps

- `trigger/steps/load-context.ts`: load DB/context for a run.
- `trigger/steps/classify-inbound.ts`: classify inbound messages (canonical classifier, Notion/Discord notification).
- `trigger/steps/update-constraints.ts`: mutate/update constraints.
- `trigger/steps/research-context.ts`: gather supporting context.
- `trigger/steps/decide-next-action.ts`: choose the next action (AI Router v2).
- `trigger/steps/draft-response.ts`: draft reply content.
- `trigger/steps/draft-initial-request.ts`: draft the initial request.
- `trigger/steps/safety-check.ts`: apply safety/review checks.
- `trigger/steps/gate-or-execute.ts`: decide whether to gate for human review or execute.
- `trigger/steps/execute-action.ts`: perform the chosen action.
- `trigger/steps/schedule-followups.ts`: set follow-up timing.
- `trigger/steps/commit-state.ts`: persist the final state updates.

## Dashboard

The operator UI lives in `dashboard/`. `dashboard/package.json` shows the active Next.js commands.

- `dashboard/app/page.tsx`: main landing page.
- `dashboard/app/requests/page.tsx`: request list.
- `dashboard/app/requests/detail-v2/page.tsx`: case detail view (primary).
- `dashboard/app/requests/new/page.tsx`: manual case creation form.
- `dashboard/app/requests/batch/page.tsx`: batch case creation.
- `dashboard/app/gated/page.tsx`: human review queue (bulk approve/dismiss).
- `dashboard/app/inbox/page.tsx`: inbox/inbound view.
- `dashboard/app/queue/page.tsx`: queue view.
- `dashboard/app/runs/page.tsx`: run visibility.
- `dashboard/app/portal-tasks/page.tsx`: portal task UI.
- `dashboard/app/shadow/page.tsx`: shadow review UI.
- `dashboard/app/simulate/page.tsx`: simulation UI.
- `dashboard/app/eval/page.tsx`: eval UI.
- `dashboard/app/agencies/page.tsx`: agency list.
- `dashboard/app/agencies/detail/page.tsx`: agency detail with track record.
- `dashboard/app/admin/page.tsx`: admin UI.
- `dashboard/app/settings/page.tsx`: settings UI.
- `dashboard/components/`: shared UI building blocks.

## Data, Queue, and Support Directories

- `database/schema.sql`: base schema reference.
- `database/migrate.js`: migration runner.
- `migrations/`: incremental SQL migrations actually applied by `server.js`.
- `queues/email-queue.js`: BullMQ workers for email sending and portal flows.
- `queues/queue-config.js`: queue configuration.
- `lib/case-reducer.js`: state reduction helpers.
- `lib/case-truth.js`: case truth/review state helpers.
- `lib/resolve-review-state.js`: review state resolution.
- `lib/email-cleaner.js`: email cleanup/normalization support.
- `utils/ai-model-metadata.js`: model metadata extraction helper.
- `utils/contact-utils.js`: contact-related utilities.
- `utils/portal-activity-events.js`: portal activity/event helpers.
- `utils/portal-utils.js`: portal utilities (includes portal system email detection).
- `utils/request-normalization.js`: request normalization helpers.
- `utils/state-utils.js`: state helpers.
- `constants/action-types.js`: action constants.
- `prompts/`: prompt sources for AI decisions/drafting.
- `tests/`: canonical automated test tree.
- `scripts/`: operational scripts — active: `test-prompt-suite.js`, `verify-migrations.js`, `serve-dashboard-static.js`. Test/eval scripts prefixed with `_`.
- `data/attachments/`: stored attachment data.
- `tasks/`: internal planning and tracking docs.

## Real Test Surface

Use these as the canonical test entrypoints:

- `npm test`: Mocha over `tests/`
- `npm run test:chaos`: reliability suite
- `npm run test:golden` and `npm run test:golden:update`: golden-case suite
- `npm run test:load`: staging/load coverage
- `npm run test:prompts`, `test:prompts:verbose`, `test:prompts:dry`: prompt suite via `scripts/test-prompt-suite.js`
- `npm run test:prompts:gate`: eval gate (blocks deploy below 90%)
- `npm run test:e2e:prompts`: prompt API end-to-end test
- `npm run test:prod-ready`, `test:prod-ready:full`, `test:contract`, `test:orchestration`, `test:idempotency`: production-readiness suite
- `npm run test:golden:runner`: alternate golden runner
- `cd dashboard && npm run lint`: dashboard validation
- `cd dashboard && npm run build`: dashboard type check and build

CI runs: `npm run typecheck` (trigger + dashboard + build) and backend regression + prompt eval gate.

## Archived Content

- `.old/root-scripts/`: one-off scripts from root directory
- `.old/test-artifacts/`: portal test results, agent logs, screenshots
- `.old/legacy-services/`: archived services (foia-case-agent, portal variants, adaptive-learning)
- `.old/docs/`: historical documentation
- `.old/screenshots/`: historical screenshots
- `.old/scripts/`: 99 one-off debug/fix/investigation scripts

## Where To Look For Specific Things

- Case lifecycle changes: `routes/run-engine.js`, `services/case-runtime.js`, `lib/case-truth.js`
- Proposal review decisions: `routes/requests/proposals.js`, `routes/run-engine.js`, `services/proposal-lifecycle.js`
- Inbound email/webhooks: `routes/webhooks.js`, `services/sendgrid-service.js`, `queues/email-queue.js`
- Trigger orchestration: `trigger/tasks/*`, `trigger/steps/*`, `trigger/lib/db.ts`
- Portal submission behavior: `routes/portal-tasks.js`, `services/portal-agent-service-skyvern.js`, `trigger/tasks/submit-portal.ts`
- Monitoring/debug APIs: `routes/monitor/*`
- System health: `routes/monitor/system-health.js`
- Request detail data for the dashboard: `routes/requests/query.js`, `dashboard/app/requests/*`
- Agency matching and contacts: `routes/agencies.js`, `routes/case-agencies.js`, `services/canonical-agency.js`, `services/pd-contact-service.js`
- Auth/admin: `routes/auth.js`, `routes/users.js`, `routes/admin.js`
- DB schema/migrations: `database/schema.sql`, `migrations/`, `services/database.js`
- Queue/worker behavior: `queues/email-queue.js`, `services/cron-service.js`
- Test entrypoints: `package.json`, `tests/`, `scripts/test-prompt-suite.js`
- Error tracking: `services/error-tracking-service.js`, `routes/eval.js` (`/api/eval/errors`)
- Quality reports: `services/quality-report-service.js`, `routes/eval.js` (`/api/eval/quality-report`, `/api/eval/reconciliation`)
